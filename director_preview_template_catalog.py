"""Named compiled Preview Stage workflow catalog with legacy import."""
from __future__ import annotations
import json
import re
import shutil
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
import folder_paths
from .director_selflift_task_store import save_preview_template as _save_single
from .director_selflift_task_store import load_preview_template as _load_single
_LOCK = threading.RLock()
_ID = re.compile(r"^[0-9a-f]{32}$")
def _root(): return Path(folder_paths.get_output_directory()) / "TerryDirector" / "preview_stage"
def _base(): return _root() / "templates"
def _write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    stage = path.with_suffix(path.suffix + ".partial")
    stage.write_text(json.dumps(value,ensure_ascii=False),encoding="utf-8")
    stage.replace(path)
def _read(path): return json.loads(path.read_text(encoding="utf-8"))
def _valid_id(value):
    if not isinstance(value,str) or not _ID.fullmatch(value): raise ValueError("无效的工作流 ID")
    return value
def _index():
    path = _base()/"index.json"
    if path.is_file(): return _read(path)
    legacy = _load_single()
    if legacy.get("schema")==2:
        tid=uuid.uuid5(uuid.NAMESPACE_URL,"TerryDirector/PreviewStage/legacy").hex
        folder=_base()/tid
        for name in ("config.json","workflow.json","api_prompt.json"):
            source=_root()/name
            if source.is_file() and not (folder/name).exists():
                folder.mkdir(parents=True,exist_ok=True)
                shutil.copy2(source,folder/name)
        item={"id":tid,"name":legacy.get("workflow_name") or "原工作流","updated_at":""}
        index={"schema":1,"default_id":tid,"items":[item]}
        _write(path,index)
        return index
    return {"schema":1,"default_id":None,"items":[]}
def _find(index,tid):
    return next((item for item in index["items"] if item["id"]==tid),None)
def list_preview_templates():
    with _LOCK:
        index=_index()
        return {"templates":[dict(item) for item in index["items"]],"default_id":index["default_id"]}
def load_preview_template(template_id=None):
    with _LOCK:
        index=_index()
        tid=template_id or index["default_id"]
        if not tid: return {}
        _valid_id(tid)
        if not _find(index,tid): raise FileNotFoundError("预演工作流不存在")
        folder=_base()/tid
        cfg=_read(folder/"config.json")
        cfg["workflow"]=_read(folder/"workflow.json")
        cfg["api_prompt"]=_read(folder/"api_prompt.json")
        cfg["template_id"]=tid
        return cfg
def save_preview_template(value):
    if not isinstance(value,dict) or value.get("schema")!=2: raise ValueError("工作流尚未编译")
    name=str(value.get("workflow_name") or "").strip()
    if not name or len(name)>100: raise ValueError("请输入 1～100 字的工作流名称")
    # Use existing strict compiler/schema validation, but avoid writing legacy
    # top-level files: validate with the same checks via a temporary shim.
    graph,api=value.get("workflow"),value.get("api_prompt")
    if not isinstance(graph,dict) or not isinstance(graph.get("nodes"),list) or not isinstance(api,dict) or not api:
        raise ValueError("工作流/API 数据不完整")
    pause=str(value.get("pause_node_id"))
    if api.get(pause,{}).get("class_type")!="TerryDirectorSelfLiftPauseResume":
        raise ValueError("工作流没有有效暂停节点")
    for field in ("prompt_binding","seed_binding"):
        bind=value.get(field) or {}
        inputs=api.get(str(bind.get("node_id")),{}).get("inputs",{})
        key=bind.get("widget_name")
        if key not in inputs or isinstance(inputs.get(key),list): raise ValueError(field+" 没有映射到独立输入")
    if str(value.get("pause_target"))!=pause or str(value.get("highres_target")) not in api:
        raise ValueError("工作流输出目标无效")
    total=sum(len(json.dumps(v,ensure_ascii=False).encode()) for v in (graph,api,value))
    if total>15*1024*1024: raise ValueError("工作流大于 15MB")
    with _LOCK:
        index=_index()
        tid=value.get("template_id")
        if tid:
            _valid_id(tid)
            if not _find(index,tid): raise FileNotFoundError("工作流不存在")
        else: tid=uuid.uuid4().hex
        folder=_base()/tid
        cfg={k:v for k,v in value.items() if k not in ("workflow","api_prompt","template_id")}
        for file,data in (("config.json",cfg),("workflow.json",graph),("api_prompt.json",api)):
            _write(folder/file,data)
        item=_find(index,tid)
        if not item:
            item={"id":tid};index["items"].append(item)
        item.update({"name":name,"updated_at":datetime.now(timezone.utc).isoformat()})
        if not index["default_id"]:index["default_id"]=tid
        _write(_base()/"index.json",index)
        return {"id":tid,"default_id":index["default_id"]}
def rename_preview_template(tid,name):
    name=str(name or "").strip()
    if not name or len(name)>100:raise ValueError("工作流名称长度必须为 1～100")
    with _LOCK:
        index=_index();_valid_id(tid)
        item=_find(index,tid)
        if not item:raise FileNotFoundError("工作流不存在")
        file=_base()/tid/"config.json";cfg=_read(file)
        cfg["workflow_name"]=name;_write(file,cfg)
        item.update({"name":name,"updated_at":datetime.now(timezone.utc).isoformat()})
        _write(_base()/"index.json",index)
def set_default_preview_template(tid):
    with _LOCK:
        index=_index();_valid_id(tid)
        if not _find(index,tid):raise FileNotFoundError("工作流不存在")
        index["default_id"]=tid;_write(_base()/"index.json",index)
def delete_preview_template(tid):
    with _LOCK:
        index=_index();_valid_id(tid)
        if not _find(index,tid):raise FileNotFoundError("工作流不存在")
        folder=_base()/tid
        if folder.is_symlink() or folder.resolve().parent!=_base().resolve():raise ValueError("工作流路径异常")
        if any(p.is_symlink() for p in folder.rglob("*")):raise ValueError("工作流包含符号链接")
        shutil.rmtree(folder)
        index["items"]=[x for x in index["items"] if x["id"]!=tid]
        if index["default_id"]==tid:index["default_id"]=index["items"][0]["id"] if index["items"] else None
        _write(_base()/"index.json",index)
        return {"default_id":index["default_id"]}
