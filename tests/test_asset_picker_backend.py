"""Model-free shared catalog/import regression tests."""
import importlib
import importlib.util
import sys
import tempfile
import types
import unittest
import os
import subprocess
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def make_test_video(path: Path) -> None:
    """A red first frame followed by blue: catch accidental mid-clip seeking."""
    import imageio_ffmpeg
    subprocess.run([
        imageio_ffmpeg.get_ffmpeg_exe(), "-v", "error", "-y",
        "-f", "lavfi", "-i", "color=c=red:s=640x360:d=0.5:r=24",
        "-f", "lavfi", "-i", "color=c=blue:s=640x360:d=0.5:r=24",
        "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]", "-map", "[v]",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", str(path),
    ], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)


class AssetPickerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.input = self.root / "input"
        self.output = self.root / "output"
        self.input.mkdir()
        self.output.mkdir()
        self.user = self.root / "user"
        spec = importlib.util.spec_from_file_location("td_assets_test", ROOT / "director_assets.py")
        self.assets = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {"folder_paths": types.SimpleNamespace(
            get_input_directory=lambda: str(self.input),
            get_output_directory=lambda: str(self.output),
            get_user_directory=lambda: str(self.user))}):
            spec.loader.exec_module(self.assets)

    def test_catalog_sources_nested_search_filter_and_pagination(self):
        (self.input / "同名.png").write_bytes(b"input")
        (self.output / "同名.png").write_bytes(b"output")
        nested = self.output / "镜头"
        nested.mkdir()
        (nested / "特瑞.PNG").write_bytes(b"png")
        (nested / "video.mp4").write_bytes(b"video")
        (nested / "ignore.txt").write_bytes(b"ignored")
        rows = self.assets.list_assets("output", "image", "镜头")
        self.assertEqual(rows["total"], 1)
        self.assertEqual(rows["files"][0]["path"], "镜头/特瑞.PNG")
        self.assertIn("type=output", rows["files"][0]["preview_url"])
        view_query = parse_qs(urlsplit(rows["files"][0]["preview_url"]).query)
        self.assertEqual(view_query["filename"], ["特瑞.PNG"])
        self.assertEqual(view_query["subfolder"], ["镜头"])
        first = self.assets.list_assets("output", limit=1)
        second = self.assets.list_assets("output", offset=1, limit=1)
        self.assertEqual(first["total"], 3)
        self.assertNotEqual(first["files"][0]["path"], second["files"][0]["path"])
        self.assertEqual(self.assets.list_assets("input")["total"], 1)

    def test_output_import_preserves_both_sources_and_is_input_compatible(self):
        (self.input / "同名.png").write_bytes(b"input")
        (self.output / "同名.png").write_bytes(b"output")
        first = self.assets.import_asset("output", "同名.png", "image")
        second = self.assets.import_asset("output", "同名.png", "image")
        self.assertNotEqual(first["path"], second["path"])
        self.assertEqual((self.input / first["path"]).read_bytes(), b"output")
        self.assertEqual((self.input / "同名.png").read_bytes(), b"input")
        self.assertEqual((self.output / "同名.png").read_bytes(), b"output")
        self.assertEqual(first["source"], "input")
        self.assertEqual(self.assets.import_asset("input", first["path"], "image"), first)

    def test_rejects_bad_roots_paths_types_and_pagination(self):
        (self.output / "video.mp4").write_bytes(b"video")
        for source, path, kind in [("temp", "video.mp4", "video"),
                                   ("output", "../input/test.png", "image"),
                                   ("output", str(self.output / "video.mp4"), "video"),
                                   ("output", "video.mp4", "image"),
                                   ("output", "missing.png", "image")]:
            with self.subTest(path=path), self.assertRaises(ValueError):
                self.assets.import_asset(source, path, kind)
        for options in [{"kind": "unknown"}, {"offset": -1}, {"limit": 151}]:
            with self.assertRaises(ValueError):
                self.assets.list_assets("output", **options)

    def test_external_links_are_not_listed_or_imported(self):
        outside = self.root / "private.png"
        outside.write_bytes(b"private")
        link = self.output / "link.png"
        try:
            link.symlink_to(outside)
        except OSError:
            self.skipTest("Symlink creation unavailable")
        self.assertEqual(self.assets.list_assets("output")["total"], 0)
        with self.assertRaises(ValueError):
            self.assets.import_asset("output", "link.png", "image")

    def test_search_and_pages_reuse_catalog_and_refresh_sees_external_files(self):
        (self.output / "first.png").write_bytes(b"image")
        with patch.object(self.assets, "_scan_catalog", wraps=self.assets._scan_catalog) as scan:
            self.assets.list_assets("output")
            self.assets.list_assets("output", query="first")
            self.assets.list_assets("output", offset=1)
            self.assertEqual(scan.call_count, 1)
            (self.output / "second.png").write_bytes(b"image")
            self.assertEqual(self.assets.list_assets("output")["total"], 1)
            self.assertEqual(self.assets.list_assets("output", refresh=True)["total"], 2)
            self.assertEqual(scan.call_count, 2)
            self.assets.invalidate_asset_catalog("output")
            self.assets.list_assets("output")
            self.assertEqual(scan.call_count, 3)

    def test_thumbnails_keep_aspect_alpha_orientation_and_original_bytes(self):
        from PIL import Image
        source = self.output / "透明.png"
        Image.new("RGBA", (1600, 800), (20, 40, 60, 90)).save(source)
        original = source.read_bytes()
        cached = self.assets.asset_thumbnail("output", source.name)
        with Image.open(cached) as thumb:
            self.assertEqual(thumb.size, (384, 192))
            self.assertEqual(thumb.mode, "RGBA")
            self.assertEqual(thumb.getpixel((0, 0))[3], 90)
        self.assertEqual(source.read_bytes(), original)
        with patch.object(Image, "open", side_effect=AssertionError("cache hit decoded original")):
            self.assertEqual(self.assets.asset_thumbnail("output", source.name), cached)
        # EXIF rotation is applied before presenting the scaled JPEG.
        jpeg = self.output / "rotated.jpg"
        image = Image.new("RGB", (1600, 800), "red")
        exif = image.getexif()
        exif[274] = 6
        image.save(jpeg, exif=exif)
        with Image.open(self.assets.asset_thumbnail("output", jpeg.name)) as thumb:
            self.assertEqual(thumb.size, (192, 384))

    def test_changed_original_invalidates_thumbnail_and_concurrent_requests_share_it(self):
        from PIL import Image
        source = self.output / "changed.png"
        Image.new("RGB", (800, 400), "red").save(source)
        old_url = self.assets.asset_record(source, "output")["thumbnail_url"]
        first = self.assets.asset_thumbnail("output", source.name)
        original_open = Image.open
        with patch.object(Image, "open", wraps=original_open) as decode, ThreadPoolExecutor(4) as pool:
            results = list(pool.map(lambda _: self.assets.asset_thumbnail("output", source.name), range(4)))
            self.assertEqual(results, [first] * 4)
            self.assertEqual(decode.call_count, 0)
        Image.new("RGB", (400, 800), "blue").save(source)
        stat = source.stat()
        os.utime(source, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1000000))
        with patch.object(Image, "open", wraps=original_open) as decode, ThreadPoolExecutor(4) as pool:
            results = list(pool.map(lambda _: self.assets.asset_thumbnail("output", source.name), range(4)))
            self.assertEqual(decode.call_count, 1)
        self.assertNotEqual(results[0], first)
        self.assertTrue(first.exists())  # In-flight responses can still open the old revision.
        self.assertNotEqual(self.assets.asset_record(source, "output")["thumbnail_url"], old_url)
        with Image.open(results[0]) as thumb:
            self.assertEqual(thumb.size, (192, 384))

    def test_corrupt_or_outside_images_cannot_produce_thumbnails(self):
        (self.output / "broken.png").write_bytes(b"not an image")
        for relative in ("broken.png", "../private.png", "file.svg"):
            with self.subTest(relative=relative), self.assertRaises((ValueError, OSError)):
                self.assets.asset_thumbnail("output", relative)

    def test_small_grayscale_alpha_and_animated_first_frame(self):
        from PIL import Image
        source = self.output / "gray.png"
        Image.new("LA", (64, 32), (120, 80)).save(source)
        with Image.open(self.assets.asset_thumbnail("output", source.name)) as thumb:
            self.assertEqual(thumb.size, (64, 32))
            self.assertEqual(thumb.getpixel((0, 0))[3], 80)
        source = self.output / "animated.gif"
        Image.new("RGB", (100, 50), "red").save(source, save_all=True,
            append_images=[Image.new("RGB", (100, 50), "blue")], duration=100, loop=0)
        with Image.open(self.assets.asset_thumbnail("output", source.name)) as thumb:
            self.assertEqual(getattr(thumb, "n_frames", 1), 1)
            red, green, blue = thumb.convert("RGB").getpixel((20, 20))
            self.assertGreater(red, 200)
            self.assertLess(blue, 30)

    def test_video_thumbnail_uses_first_frame_and_reuses_disk_cache(self):
        from PIL import Image
        nested = self.output / "视频素材"
        nested.mkdir()
        source = nested / "首帧 sample.mp4"
        make_test_video(source)
        original = source.read_bytes()
        record = self.assets.asset_record(source, "output")
        self.assertIn("/assets/thumbnail?", record["thumbnail_url"])
        with patch.object(self.assets, "_video_first_frame", wraps=self.assets._video_first_frame) as decode:
            first = self.assets.asset_thumbnail("output", "视频素材/首帧 sample.mp4")
            self.assertEqual(self.assets.asset_thumbnail("output", "视频素材/首帧 sample.mp4"), first)
            self.assertEqual(decode.call_count, 1)
        with Image.open(first) as thumb:
            self.assertEqual(thumb.size, (384, 216))
            red, green, blue = thumb.convert("RGB").getpixel((100, 100))
            self.assertGreater(red, 220)
            self.assertLess(blue, 30)
        self.assertEqual(source.read_bytes(), original)
        (self.output / "broken.mp4").write_bytes(b"not a video")
        with self.assertRaises(ValueError):
            self.assets.asset_thumbnail("output", "broken.mp4")


class AssetPickerHTTPTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        from aiohttp import web
        from aiohttp.test_utils import TestClient, TestServer
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for source in ("input", "output"):
            (self.root / source).mkdir()
        routes = web.RouteTableDef()
        package = types.ModuleType("_td_asset_http_test")
        package.__path__ = [str(ROOT)]
        self.modules = patch.dict(sys.modules, {
            "folder_paths": types.SimpleNamespace(
                get_input_directory=lambda: str(self.root / "input"),
                get_output_directory=lambda: str(self.root / "output"),
                get_user_directory=lambda: str(self.root / "user")),
            "server": types.SimpleNamespace(PromptServer=types.SimpleNamespace(
                instance=types.SimpleNamespace(routes=routes))),
            package.__name__: package,
        })
        self.modules.start()
        self.addCleanup(self.modules.stop)
        importlib.import_module(package.__name__ + ".server_routes")
        app = web.Application()
        app.add_routes(routes)
        self.client = TestClient(TestServer(app))
        await self.client.start_server()
        self.addAsyncCleanup(self.client.close)

    async def test_catalog_to_import_http_contract(self):
        (self.root / "output" / "特瑞.png").write_bytes(b"output image")
        response = await self.client.get("/terrydirector/api/assets", params={
            "source": "output", "kind": "image", "q": "特瑞"})
        self.assertEqual(response.status, 200)
        row = (await response.json())["files"][0]
        response = await self.client.post("/terrydirector/api/assets/import", json={
            "source": row["source"], "path": row["path"], "kind": row["kind"]})
        self.assertEqual(response.status, 200)
        selected = await response.json()
        self.assertEqual(selected["source"], "input")
        self.assertEqual((self.root / "input" / selected["path"]).read_bytes(), b"output image")
        self.assertIn("type=input", selected["preview_url"])

    async def test_bad_http_requests_are_rejected(self):
        for query in ({"source": "temp"}, {"offset": "oops"}, {"kind": "latent"}):
            response = await self.client.get("/terrydirector/api/assets", params=query)
            self.assertEqual(response.status, 400)
        for payload in ([], {"source": "output", "path": "../private.png", "kind": "image"}):
            response = await self.client.post("/terrydirector/api/assets/import", json=payload)
            self.assertEqual(response.status, 400)

    async def test_thumbnail_http_response_is_small_cached_and_refreshable(self):
        from PIL import Image
        from io import BytesIO
        Image.new("RGB", (2048, 1024), "blue").save(self.root / "output" / "large.png")
        response = await self.client.get("/terrydirector/api/assets", params={"source": "output"})
        row = (await response.json())["files"][0]
        self.assertIn("/assets/thumbnail?", row["thumbnail_url"])
        response = await self.client.get(row["thumbnail_url"])
        self.assertEqual(response.status, 200)
        self.assertEqual(response.content_type, "image/webp")
        data = await response.read()
        with Image.open(BytesIO(data)) as thumb:
            self.assertEqual(thumb.size, (384, 192))
        etag = response.headers["ETag"]
        response = await self.client.get(row["thumbnail_url"], headers={"If-None-Match": etag})
        self.assertEqual(response.status, 304)
        response = await self.client.get("/terrydirector/api/assets/thumbnail", params={
            "source": "output", "path": "../private.png"})
        self.assertEqual(response.status, 400)
        (self.root / "output" / "new.png").write_bytes(b"new")
        response = await self.client.get("/terrydirector/api/assets", params={"source": "output", "refresh": "1"})
        self.assertEqual((await response.json())["total"], 2)

    async def test_video_first_frame_http_thumbnail(self):
        from io import BytesIO
        from PIL import Image
        make_test_video(self.root / "input" / "sample.mp4")
        response = await self.client.get("/terrydirector/api/assets", params={"source": "input", "kind": "video"})
        row = (await response.json())["files"][0]
        response = await self.client.get(row["thumbnail_url"])
        self.assertEqual(response.status, 200)
        self.assertEqual(response.content_type, "image/webp")
        with Image.open(BytesIO(await response.read())) as thumb:
            self.assertEqual(thumb.size, (384, 216))
            self.assertGreater(thumb.convert("RGB").getpixel((100, 100))[0], 220)


if __name__ == "__main__":
    unittest.main()
