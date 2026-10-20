"""GPU ridge training for opening-strategy estimates; simulation remains in Node on CPU.
Uses the installed NVIDIA CUDA driver directly; no package or model downloads.
Never deploys a policy. Split entire match seeds to prevent correlated trial leakage.
"""
import argparse, ctypes as C, json, math, statistics, time, hashlib
from collections import Counter
from pathlib import Path

PTX = r"""
.version 6.0
.target sm_52
.address_size 64
.visible .entry predict(.param .u64 X,.param .u64 W,.param .u64 Y,.param .u64 E,.param .u32 N,.param .u32 D){
.reg .pred %p<3>; .reg .b32 %r<12>; .reg .b64 %a<12>; .reg .f32 %f<8>;
ld.param.u64 %a0,[X];ld.param.u64 %a1,[W];ld.param.u64 %a2,[Y];ld.param.u64 %a3,[E];
ld.param.u32 %r0,[N];ld.param.u32 %r1,[D];mov.u32 %r2,%tid.x;mov.u32 %r3,%ctaid.x;mov.u32 %r4,%ntid.x;
mad.lo.u32 %r5,%r3,%r4,%r2;setp.ge.u32 %p0,%r5,%r0;@%p0 bra END;
mul.lo.u32 %r6,%r5,%r1;mov.u32 %r7,0;mov.f32 %f0,0f00000000;
LOOP: setp.ge.u32 %p1,%r7,%r1;@%p1 bra DONE;
add.u32 %r8,%r6,%r7;mul.wide.u32 %a4,%r8,4;add.u64 %a5,%a0,%a4;ld.global.f32 %f1,[%a5];
mul.wide.u32 %a6,%r7,4;add.u64 %a7,%a1,%a6;ld.global.f32 %f2,[%a7];
mul.f32 %f3,%f1,%f2;add.f32 %f0,%f0,%f3;add.u32 %r7,%r7,1;bra LOOP;
DONE: mul.wide.u32 %a8,%r5,4;add.u64 %a9,%a2,%a8;ld.global.f32 %f4,[%a9];sub.f32 %f5,%f0,%f4;
add.u64 %a10,%a3,%a8;st.global.f32 [%a10],%f5;
END: ret;
}
.visible .entry update(.param .u64 X,.param .u64 W,.param .u64 E,.param .u64 O,.param .u32 N,.param .u32 D,.param .f32 LR,.param .f32 L2){
.reg .pred %p<3>; .reg .b32 %r<12>; .reg .b64 %a<12>; .reg .f32 %f<12>;
ld.param.u64 %a0,[X];ld.param.u64 %a1,[W];ld.param.u64 %a2,[E];ld.param.u64 %a3,[O];
ld.param.u32 %r0,[N];ld.param.u32 %r1,[D];ld.param.f32 %f8,[LR];ld.param.f32 %f9,[L2];
mov.u32 %r2,%tid.x;mov.u32 %r3,%ctaid.x;mov.u32 %r4,%ntid.x;mad.lo.u32 %r5,%r3,%r4,%r2;
setp.ge.u32 %p0,%r5,%r1;@%p0 bra END;mov.u32 %r6,0;mov.f32 %f0,0f00000000;
LOOP: setp.ge.u32 %p1,%r6,%r0;@%p1 bra DONE;
mad.lo.u32 %r7,%r6,%r1,%r5;mul.wide.u32 %a4,%r7,4;add.u64 %a5,%a0,%a4;ld.global.f32 %f1,[%a5];
mul.wide.u32 %a6,%r6,4;add.u64 %a7,%a2,%a6;ld.global.f32 %f2,[%a7];
mul.f32 %f3,%f1,%f2;add.f32 %f0,%f0,%f3;add.u32 %r6,%r6,1;bra LOOP;
DONE: cvt.rn.f32.u32 %f4,%r0;div.rn.f32 %f5,%f0,%f4;
mul.wide.u32 %a8,%r5,4;add.u64 %a9,%a1,%a8;ld.global.f32 %f6,[%a9];
mul.f32 %f7,%f9,%f6;add.f32 %f5,%f5,%f7;mul.f32 %f5,%f5,%f8;sub.f32 %f6,%f6,%f5;
add.u64 %a10,%a3,%a8;st.global.f32 [%a10],%f6;
END: ret;
}
"""

class GPU:
 def __init__(self):
  self.lib=C.WinDLL('nvcuda.dll') if hasattr(C,'WinDLL') else C.CDLL('libcuda.so.1')
  self.allocations=[];self.ctx=C.c_void_p();self.module=C.c_void_p()
  self.call('cuInit',[C.c_uint],0);dev=C.c_int();self.call('cuDeviceGet',[C.c_void_p,C.c_int],C.byref(dev),0)
  name=C.create_string_buffer(256);self.call('cuDeviceGetName',[C.c_void_p,C.c_int,C.c_int],name,256,dev.value);self.name=name.value.decode()
  self.call('cuCtxCreate_v2',[C.c_void_p,C.c_uint,C.c_int],C.byref(self.ctx),0,dev.value)
  try:
   code=C.create_string_buffer(PTX.encode());self.call('cuModuleLoadData',[C.c_void_p,C.c_void_p],C.byref(self.module),code)
   self.functions={}
   for name in ['predict','update']:
    f=C.c_void_p();self.call('cuModuleGetFunction',[C.c_void_p,C.c_void_p,C.c_char_p],C.byref(f),self.module,name.encode());self.functions[name]=f
  except Exception:self.close();raise
 def call(self,name,types,*args):
  f=getattr(self.lib,name);f.argtypes=types;f.restype=C.c_int;code=f(*args)
  if code:raise RuntimeError(f'{name}: CUDA error {code}')
 def upload(self,values):
  data=(C.c_float*len(values))(*values);pointer=C.c_uint64();self.call('cuMemAlloc_v2',[C.c_void_p,C.c_size_t],C.byref(pointer),C.sizeof(data));self.allocations.append(pointer.value)
  self.call('cuMemcpyHtoD_v2',[C.c_uint64,C.c_void_p,C.c_size_t],pointer.value,data,C.sizeof(data));return pointer.value
 def read(self,pointer,size):
  data=(C.c_float*size)();self.call('cuMemcpyDtoH_v2',[C.c_void_p,C.c_uint64,C.c_size_t],data,pointer,C.sizeof(data));return list(data)
 def launch(self,name,threads,args):
  ptrs=(C.c_void_p*len(args))(*[C.cast(C.byref(a),C.c_void_p).value for a in args])
  self.call('cuLaunchKernel',[C.c_void_p]+[C.c_uint]*7+[C.c_void_p]*3,self.functions[name],(threads+63)//64,1,1,64,1,1,0,None,ptrs,None)
 def train(self,x,y,steps=1800,lr=.15,l2=.02):
  if not 1<=steps<=50000:raise ValueError('steps must be between 1 and 50000')
  n=len(y);d=len(x[0]);assert 0<n<=100000 and 0<d<=2048 and n*d*4<64*1024*1024
  start=time.perf_counter();px=self.upload([v for row in x for v in row]);py=self.upload(y);pw=self.upload([0.]*d);po=self.upload([0.]*d);pe=self.upload([0.]*n)
  for _ in range(steps):
   self.launch('predict',n,[C.c_uint64(v) for v in [px,pw,py,pe]]+[C.c_uint32(n),C.c_uint32(d)])
   self.launch('update',d,[C.c_uint64(v) for v in [px,pw,pe,po]]+[C.c_uint32(n),C.c_uint32(d),C.c_float(lr),C.c_float(l2)]);pw,po=po,pw
  self.call('cuCtxSynchronize',[]);weights=self.read(pw,d)
  assert all(math.isfinite(v) for v in weights)
  return weights,{'device':self.name,'backend':'CUDA driver / PTX','iterations':steps,'kernelLaunches':2*steps,'seconds':time.perf_counter()-start,'trainingMatrixBytes':n*d*4,'samples':n,'features':d}
 def close(self):
  for p in self.allocations:
   try:self.call('cuMemFree_v2',[C.c_uint64],p)
   except Exception:pass
  self.allocations=[]
  if self.module.value:self.call('cuModuleUnload',[C.c_void_p],self.module);self.module=C.c_void_p()
  if self.ctx.value:self.call('cuCtxDestroy_v2',[C.c_void_p],self.ctx);self.ctx=C.c_void_p()

def self_test():
 gpu=GPU()
 try:
  x=[[1.,0.],[0.,1.],[1.,1.]];y=[.5,-.25,.25];w,info=gpu.train(x,y,steps=1,lr=.1,l2=0)
  expected=[.1*(.5+.25)/3,.1*(-.25+.25)/3];err=max(abs(a-b) for a,b in zip(w,expected));assert err<1e-6,(w,expected)
  w,_=gpu.train(x,y,steps=1000,lr=.2,l2=0);assert max(abs(a-b) for a,b in zip(w,[.5,-.25]))<1e-5
  print(json.dumps({'gpuSelfTest':True,'maxGradientError':err,**info}));return
 finally:gpu.close()

def games(obj):
 if isinstance(obj,dict):
  if all(k in obj for k in ['seed','difficulty','rounds','bands','metrics']):yield obj
  else:
   for value in obj.values():yield from games(value)
 elif isinstance(obj,list):
  for value in obj:yield from games(value)

def defense_loss(observations, normal_rounds=13, objective='counts'):
 if not 0<len(observations)<=normal_rounds:raise ValueError('Invalid observed round count')
 missing=normal_rounds-len(observations)
 if objective=='counts':
  # Affine equivalent of defenseMetrics: 25 per leak, 100 leak ratio, 450 lost-round opportunity cost.
  return (sum((25*p['leaks']+100*min(1,p['leaks']/max(1,p['total'])))/450 for p in observations)+missing)/normal_rounds
 if objective=='ratio':return sum(p['leaks']/max(1,p['total']) for p in observations)/normal_rounds + 1.5*missing/normal_rounds
 raise ValueError('Unknown objective')

def fit(args):
 seen=set();rows=[];input_hashes={}
 for file in args.input:
  path=Path(file);input_hashes[str(path)]=hashlib.sha256(path.read_bytes()).hexdigest()
  for run in games(json.loads(path.read_text(encoding='utf8'))):
   if run['difficulty']!=args.difficulty:continue
   key=(run['seed'],run.get('policy'),json.dumps(run.get('parameters',{}),sort_keys=True))
   if key in seen:continue
   seen.add(key)
   for pid,band in run['bands'].items():
    observations=[rd['players'][pid] for rd in run['rounds'] if rd['players'][pid].get('aliveBefore')]
    if not observations:continue
    # Own-field leaks count before teammate rescue; eliminated rounds carry a larger penalty.
    loss=(0. if run['victory'] else 1.) + 0.2*defense_loss(observations) if args.objective=='victory' else defense_loss(observations,objective=args.objective)
    rows.append({'seed':run['seed'],'stage':run['stageId'],'band':band,'team':[v for p,v in run['bands'].items() if p!=pid],'loss':loss})
 assert rows,'No matching difficulty data found'
 bands=sorted({r['band'] for r in rows});stages=sorted({r['stage'] for r in rows});features=['band:'+b for b in bands]+['stage:'+s for s in stages]+['team:'+b for b in bands];ix={f:i for i,f in enumerate(features)}
 def vector(r):
  x=[0.]*len(features);x[ix['band:'+r['band']]]=1.;x[ix['stage:'+r['stage']]]=1.
  for b in r['team']:x[ix['team:'+b]]+=1/3
  return x
 train=[r for r in rows if r['seed']%5!=0];hold=[r for r in rows if r['seed']%5==0];assert len(train)>100 and len(hold)>20
 assert not ({r['seed'] for r in train}&{r['seed'] for r in hold})
 mean=statistics.mean(r['loss'] for r in train);gpu=GPU()
 try:w,info=gpu.train([vector(r) for r in train],[r['loss']-mean for r in train],steps=args.steps)
 finally:gpu.close()
 pred=lambda r:mean+sum(a*b for a,b in zip(w,vector(r)))
 mse=lambda data:statistics.mean((r['loss']-pred(r))**2 for r in data)
 baseline=statistics.mean((r['loss']-mean)**2 for r in hold);error=mse(hold);counts=Counter(r['band'] for r in train)
 policy=json.loads(Path(args.base_policy).read_text(encoding='utf8'));bias=dict(policy.get('bandDefenseBias',{}).get(args.difficulty,{}));adjustments={}
 for b in bands:
  # A small bounded bias; no invented estimates for scarcely sampled strategies.
  delta=max(-args.bias_cap,min(args.bias_cap,-w[ix['band:'+b]]*args.bias_scale)) if counts[b]>=20 else 0.
  adjustments[b]=round(delta,4);bias[b]=round(bias.get(b,0)+delta,4)
 policy.setdefault('bandDefenseBias',{})[args.difficulty]=bias
 out=Path(args.output);out.parent.mkdir(parents=True,exist_ok=True);out.write_text(json.dumps(policy,indent=2)+'\n',encoding='utf8')
 report={'objective':args.objective,'sourceSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'gpu':info,'inputsSha256':input_hashes,'difficulty':args.difficulty,'trainingGames':len(seen),'samples':len(rows),'trainSeeds':sorted({r['seed'] for r in train}),'heldoutSeeds':sorted({r['seed'] for r in hold}),'trainMSE':mse(train),'heldoutMSE':error,'constantBaselineMSE':baseline,'heldoutImprovesConstant':error<baseline,'bandTrainingCounts':dict(counts),'boundedBandAdjustments':adjustments,'features':features,'weights':w,'targetMean':mean,'limitation':'Supervised opening-strategy estimate, not an end-to-end battle agent. GPU fit is not proof of game improvement; independent simulation is required. No deployment performed.'}
 out.with_suffix('.training.json').write_text(json.dumps(report,indent=2)+'\n',encoding='utf8');print(json.dumps({k:report[k] for k in ['gpu','difficulty','trainingGames','samples','trainMSE','heldoutMSE','constantBaselineMSE','heldoutImprovesConstant']}))

if __name__=='__main__':
 a=argparse.ArgumentParser();a.add_argument('--self-test',action='store_true');a.add_argument('--objective',choices=['counts','ratio','victory'],default='counts');a.add_argument('--difficulty',choices=['HARD','ABYSS'],default='HARD');a.add_argument('--bias-scale',type=float,default=20.);a.add_argument('--bias-cap',type=float,default=3.);a.add_argument('--input',action='append',default=[]);a.add_argument('--base-policy');a.add_argument('--output');a.add_argument('--steps',type=int,default=1800);args=a.parse_args()
 if args.self_test:self_test()
 else:
  if not args.input or not args.base_policy or not args.output:a.error('--input, --base-policy and --output required')
  fit(args)
