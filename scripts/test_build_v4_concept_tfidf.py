#!/usr/bin/env python3
import importlib.util, pathlib, unittest

MODULE = pathlib.Path(__file__).with_name("build_v4_concept_tfidf.py")
spec = importlib.util.spec_from_file_location("concept_builder", MODULE)
builder = importlib.util.module_from_spec(spec); spec.loader.exec_module(builder)

class BuilderTests(unittest.TestCase):
    def test_overlap_uses_most_specific_v5_interval_and_keeps_provenance(self):
        rows=[{"id":i,"pali_text":"sati dhamma","rend":"bodytext"} for i in range(1,7)]
        work={"id":"s-testa_att","level":"atthakatha","title":"T","path":[]}
        refs=[{"start":1,"end":6,"root_work_id":"s-root","unit_id":"wide"},{"start":3,"end":4,"root_work_id":"s-root","unit_id":"specific"}]
        docs=builder.canonical_segments(rows,work,refs,[])
        target=next(x for x in docs if x["row_start"]==3)
        self.assertEqual((target["row_start"],target["row_end"]),(3,4))
        self.assertEqual(len(target["v5_units"]),2)

    def test_tfidf_keeps_core_term_without_high_idf(self):
        docs=[]
        for i in range(3):
            docs.append({"doc_id":f"w{i}:1-1","parent_work_id":f"w{i}","work_id":f"w{i}","layer":"mula","title":"","path":[],"row_start":1,"row_end":1,"segmentation_method":"test","v5_units":[],"rows":[{"id":1,"pali_text":"sati sati"}]})
        concepts,postings,_,n=builder.tfidf_build(docs,{"sati"},{"sati":"念"})
        self.assertEqual(n,3); self.assertEqual(concepts[0]["admission"],"core"); self.assertEqual(len(postings["sati"]),3)

    def test_v5_format_constant_never_points_to_v2(self):
        self.assertEqual(builder.V5_FORMAT,"tipitaka-commentary-links/v5")
        self.assertNotIn("v2",builder.ROOTS)

if __name__ == "__main__": unittest.main()
