import importlib.util
from pathlib import Path
import unittest

path = Path(__file__).resolve().parents[1] / "tools" / "summarize_selflift_trace.py"
spec = importlib.util.spec_from_file_location("trace_summary", path)
summary = importlib.util.module_from_spec(spec); spec.loader.exec_module(summary)

class SummaryTests(unittest.TestCase):
    def test_complete_synthetic_trace_passes(self):
        data = [{"prompt_id":"p", "session":"one", "event":"plan", "segments":[{"id":"clip-1"}]}]
        names = ("conditioning", "selflift", "low_sampling", "resolution_transition", "latent_upscale", "high_sampling", "latent_checkpoint", "decode_cache", "final_output")
        for number, name in enumerate(names):
            base = {"prompt_id":"p", "session":"one", "span_id":name, "parent_id":None,
                    "name":name, "node_id":"n", "segment_id":"clip-1" if name != "final_output" else None}
            data.extend([{**base,"event":"begin","sigma_count":2},
                         {**base,"event":"end","start_ns":number*100,"end_ns":number*100+90,"status":"ok"}])
            if name in ("low_sampling","high_sampling"):
                data.extend([{**base,"event":"step_callback","callback_index":1},
                             {**base,"event":"sampler_return","callbacks":1}])
        self.assertTrue(summary.summarize(data,"p",1)["integrity_ok"])
        data.append({"prompt_id":"p", "session":"other", "event":"noise"})
        self.assertFalse(summary.summarize(data,"p",1)["integrity_ok"])

    def test_union_does_not_double_count(self):
        self.assertEqual(summary.union_ns([(0,10),(2,7),(8,20),(30,35)]), 25)
    def test_empty_or_other_prompt_is_not_success(self):
        for values in ([], [{"prompt_id":"other", "event":"plan"}]):
            self.assertFalse(summary.summarize(values, "wanted")["integrity_ok"])
    def test_incomplete_span_is_reported(self):
        result = summary.summarize([{"prompt_id":"p","event":"begin","span_id":"s","name":"low_sampling"}], "p")
        self.assertIn("missing end: s", result["integrity_errors"])
    def test_parent_inclusive_and_child_are_not_added(self):
        data = []
        for key,parent,start,end in (("root",None,0,10000000000),("child","root",2000000000,5000000000)):
            base = {"prompt_id":"p","span_id":key,"parent_id":parent,"name":key,"node_id":"n"}
            data += [{**base,"event":"begin"}, {**base,"event":"end","start_ns":start,"end_ns":end,"status":"ok"}]
        result = summary.summarize(data, "p")
        self.assertEqual(result["measured_root_union_s"], 10)
        self.assertEqual(result["spans"][0]["outside_children_s"], 7)
        self.assertFalse(result["integrity_ok"])  # No real three-segment plan.

if __name__ == "__main__": unittest.main()
