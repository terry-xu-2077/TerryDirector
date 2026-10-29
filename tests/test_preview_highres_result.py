"""Highres Preview Stage outputs: exact-history matching and safe file references."""
import importlib
import sys
import tempfile
import types
import unittest
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
PKG="td_preview_highres_testpkg"


class HighresPreviewTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.names=(PKG,PKG+".director_preview_highres",
                   PKG+".director_selflift_task_store","folder_paths")
        cls.previous={n:sys.modules.get(n) for n in cls.names}
        pkg=types.ModuleType(PKG)
        pkg.__path__=[str(ROOT)]
        sys.modules[PKG]=pkg
        sys.modules["folder_paths"]=types.SimpleNamespace(get_output_directory=lambda:"")
        cls.module=importlib.import_module(PKG+".director_preview_highres")

    @classmethod
    def tearDownClass(cls):
        for key,value in cls.previous.items():
            if value is None:
                sys.modules.pop(key,None)
            else:
                sys.modules[key]=value

    def setUp(self):
        temp=tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root=Path(temp.name)
        sys.modules["folder_paths"].get_output_directory=lambda:str(self.root)
        (self.root/"video").mkdir()
        (self.root/"video"/"scene_00001_.mp4").write_bytes(b"fake video bytes")
        self.result={"filename":"scene_00001_.mp4","subfolder":"video","type":"output"}

    def test_core_savevideo_images_ui_output(self):
        history={"p01":{"outputs":{"42":{"images":[self.result],"animated":[True]}}}}
        self.assertEqual(self.module.highres_from_history(history,"p01","42"),self.result)
        self.assertIsNone(self.module.highres_from_history(history,"p01","43"))
        self.assertIsNone(self.module.highres_from_history(history,"another","42"))
        self.assertEqual(self.module.highres_video_path(self.result),
                         (self.root/"video"/"scene_00001_.mp4").resolve())

    def test_vhs_gifs_ui_output(self):
        history={"p02":{"outputs":{"42":{"gifs":[self.result]}}}}
        self.assertEqual(self.module.highres_from_history(history,"p02","42"),self.result)

    def test_untrusted_file_paths_rejected(self):
        outside=(self.root.parent/"outside.mp4")
        for item in [
            {"filename":"../outside.mp4","subfolder":"","type":"output"},
            {"filename":"scene_00001_.mp4","subfolder":"../video","type":"output"},
            {"filename":"scene_00001_.mp4","subfolder":"video","type":"input"},
            {"filename":"bad.png","subfolder":"video","type":"output"},
            {"filename":"C:\\outside.mp4","subfolder":"","type":"output"},
            {"filename":"not_found.mp4","subfolder":"video","type":"output"},
            {"filename":"scene_00001_.mp4","subfolder":"/video","type":"output"},
        ]:
            self.assertIsNone(self.module.validated_video_result(item),item)
        self.assertFalse(outside.is_file())

    def test_recover_and_persist_from_exact_prompt(self):
        saved={"a"*32:{"highres_target":"42","workflow_name":"test"}}
        def load(checkpoint_id):
            return dict(saved[checkpoint_id])
        def save(checkpoint_id,meta):
            saved[checkpoint_id]=meta
        sys.modules[PKG+".director_selflift_task_store"]=types.SimpleNamespace(
            load_metadata=load,save_metadata=save)
        rows=[{"id":"draft_1","status":"high_complete","checkpoint_id":"a"*32,
               "prompt_id":"p01","media":{"sampling":None},"metadata":{}}]
        class Queue:
            def get_history(self,prompt_id=None):
                self_called.append(prompt_id)
                return {"p01":{"outputs":{"42":{"images":[self_result]}}}}
        self_called=[]
        self_result=self.result
        self.module.recover_highres_videos(rows,Queue())
        self.assertEqual(self_called,["p01"])
        self.assertEqual(rows[0]["media"]["highres"],self.result["filename"])
        self.assertEqual(saved["a"*32]["highres_prompt_id"],"p01")
        self.assertEqual(saved["a"*32]["highres_video"],self.result)
        # After history disappears the cached pointer still validates.
        self.assertIsNotNone(self.module.validated_video_result(saved["a"*32]["highres_video"]))

    def test_never_match_other_completed_job(self):
        history={"p-other":{"outputs":{"42":{"images":[self.result]}}}}
        self.assertIsNone(self.module.highres_from_history(history,"p-current","42"))


if __name__=="__main__":
    unittest.main()
