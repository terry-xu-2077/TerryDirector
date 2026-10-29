"""Keep raw failed KJ MP4 for diagnosis; delete it if fallback succeeds."""
import importlib
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
PACKAGE="td_preview_failed_sample_testpkg"


class FailedSamplingPreviewTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        names=[PACKAGE,PACKAGE+".director_selflift_task_store",
               PACKAGE+".director_selflift_checkpoint",
               PACKAGE+".director_preview_mp4","folder_paths"]
        cls.previous={name:sys.modules.get(name) for name in names}
        pkg=types.ModuleType(PACKAGE)
        pkg.__path__=[str(ROOT)]
        sys.modules[PACKAGE]=pkg
        sys.modules["folder_paths"]=types.SimpleNamespace(get_output_directory=lambda:"")
        sys.modules[PACKAGE+".director_selflift_checkpoint"]=types.SimpleNamespace(
            list_checkpoints=lambda:[],read_manifest=lambda _:None)
        cls.mp4=types.ModuleType(PACKAGE+".director_preview_mp4")
        cls.mp4.finalize_preview_mp4=lambda *_:None
        sys.modules[PACKAGE+".director_preview_mp4"]=cls.mp4
        cls.store=importlib.import_module(PACKAGE+".director_selflift_task_store")

    @classmethod
    def tearDownClass(cls):
        for name,value in cls.previous.items():
            if value is None:
                sys.modules.pop(name,None)
            else:
                sys.modules[name]=value

    def setUp(self):
        temp=tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root=Path(temp.name)
        self.checkpoint=self.root/"checkpoint"
        self.checkpoint.mkdir()
        self.debug=self.checkpoint/"sampling_preview_failed.bin"
        self.id="a"*32
        self.patcher=patch.object(self.store,"checkpoint_dir",return_value=self.checkpoint)
        self.patcher.start()
        self.addCleanup(self.patcher.stop)

    def test_preserve_newest_failed_bytes_and_remove_after_valid_fallback(self):
        newest=b"\x00\x00\x00\x18ftypisom" + b"x"*50
        older=b"\x00\x00\x00\x18ftypisom" + b"y"*50
        with patch.object(self.mp4,"finalize_preview_mp4",side_effect=ValueError("Invalid NAL unit size")):
            with self.assertRaisesRegex(ValueError,"Invalid NAL"):
                self.store.save_sampling_preview(self.id,"video/mp4",newest,15)
            self.assertEqual(self.debug.read_bytes(),newest)
            with self.assertRaisesRegex(ValueError,"Invalid NAL"):
                self.store.save_sampling_preview(self.id,"video/mp4",older,15)
            self.assertEqual(self.debug.read_bytes(),newest,
                             "Always preserve the newest failed candidate")
        def success(raw,folder,duration):
            self.assertEqual(raw,older)
            self.assertEqual(duration,15)
            path=folder/"sampling_preview.mp4"
            path.write_bytes(b"valid-result")
            return path
        with patch.object(self.mp4,"finalize_preview_mp4",side_effect=success):
            self.assertEqual(self.store.save_sampling_preview(
                self.id,"video/mp4",older,15),"sampling_preview.mp4")
        self.assertFalse(self.debug.exists())
        self.assertEqual((self.checkpoint/"sampling_preview.mp4").read_bytes(),
                         b"valid-result")

    def test_oversized_payload_rejected_without_debug_file(self):
        with self.assertRaises(ValueError):
            self.store.save_sampling_preview(self.id,"video/mp4",
                                             b"x"*(self.store._MAX_PREVIEW+1))
        self.assertFalse(self.debug.exists())


if __name__=="__main__":
    unittest.main()
