import importlib.util, unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('gpu_train',Path(__file__).with_name('train-ai-gpu.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class TrainingRules(unittest.TestCase):
 def test_absolute_leaks_matter_even_at_equal_ratio(self):
  self.assertGreater(m.defense_loss([{'leaks':10,'total':20}]*13),m.defense_loss([{'leaks':1,'total':2}]*13))
 def test_missing_rounds_do_not_improve_average(self):
  alive=[{'leaks':0,'total':10}]*13
  self.assertEqual(m.defense_loss(alive),0)
  self.assertGreater(m.defense_loss(alive[:6]),m.defense_loss(alive[:12]))
 def test_equivalent_to_fixed_horizon_defense_score(self):
  rows=[{'leaks':i%3,'total':10} for i in range(11)]
  score=(sum(100-25*r['leaks']-100*r['leaks']/r['total'] for r in rows)-350*2)/13
  self.assertAlmostEqual(m.defense_loss(rows),(100-score)/450)
 def test_report_walk_and_duplicate_input_structure(self):
  run={'seed':1,'difficulty':'HARD','rounds':[],'bands':{},'metrics':{}}
  self.assertEqual(list(m.games({'study':{'results':[run]},'summary':{'games':2}})),[run])
if __name__=='__main__':unittest.main()
