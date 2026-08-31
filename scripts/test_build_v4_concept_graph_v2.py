import gzip, json, pathlib, tempfile, unittest

class GraphV2BuilderContractTest(unittest.TestCase):
    def test_pali_folding_keeps_diacritic_equivalence(self):
        import importlib.util
        p=pathlib.Path(__file__).with_name('build_v4_concept_graph_v2.py')
        s=importlib.util.spec_from_file_location('builder',p); m=importlib.util.module_from_spec(s); s.loader.exec_module(m)
        self.assertEqual(m.fold_pali('sila'), m.fold_pali('sīla'))
        self.assertNotEqual(m.norm_pali('sila'), m.norm_pali('sīla'))
    def test_safe_canonical_never_accepts_unknown_token(self):
        import importlib.util
        p=pathlib.Path(__file__).with_name('build_v4_concept_graph_v2.py')
        s=importlib.util.spec_from_file_location('builder2',p); m=importlib.util.module_from_spec(s); s.loader.exec_module(m)
        self.assertEqual(m.safe_canonical('invented', 'sīla', {'sīla'}, {'sīla'}), 'sīla')
    def test_manifest_schema_constants(self):
        import importlib.util
        p=pathlib.Path(__file__).with_name('build_v4_concept_graph_v2.py')
        s=importlib.util.spec_from_file_location('builder3',p); m=importlib.util.module_from_spec(s); s.loader.exec_module(m)
        self.assertEqual(len(m.ALLOWED_TYPES), 8)
        self.assertEqual(len(m.RELATION_TYPES), 17)
        self.assertEqual(len(m.FORMAL_RELATIONS), 15)

if __name__ == '__main__': unittest.main()
