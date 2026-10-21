/** TerryDirector SelfLift checkpoint pause/resume UI.
 *
 * Each run returns a regular ComfyUI "executed" UI payload. The frontend
 * writes its checkpoint_id back into the node widget, so Save Workflow stores
 * the actual ID rather than an ephemeral display-only execution result.
 */
import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const CLASS_NAME = "TerryDirectorSelfLiftPauseResume";
const TITLE = "TerryDirector SelfLift 暂停/继续";

function widget(node, name) {
  return node?.widgets?.find(item => item.name === name);
}

function refreshTitle(node) {
  if (node?.comfyClass !== CLASS_NAME) return;
  const id = String(widget(node, "checkpoint_id")?.value || "").trim();
  const mode = String(widget(node, "mode")?.value || "");
  const name = String(widget(node, "name")?.value || "").trim();
  if (!id) {
    node.title = TITLE + " · 未保存";
  } else {
    const action = mode === "继续高清" ? "待继续" : "已保存";
    const shortName = name ? name.slice(0, 12) + " · " : "";
    node.title = TITLE + " · " + shortName + action + " " + id.slice(0, 8);
  }
  node.setDirtyCanvas?.(true, true);
}

function attach(node) {
  if (node?.comfyClass !== CLASS_NAME) return;
  if (!node.__tdSelfLiftPauseResumeBound) {
    node.__tdSelfLiftPauseResumeBound = true;
    for (const field of ["mode", "checkpoint_id", "name"]) {
      const target = widget(node, field);
      if (!target) continue;
      const original = target.callback;
      target.callback = function (...args) {
        const result = original?.apply(this, args);
        refreshTitle(node);
        return result;
      };
    }
  }
  refreshTitle(node);
}

function bindExecutionResult() {
  if (api.__tdSelfLiftPauseResumeBound) return;
  api.__tdSelfLiftPauseResumeBound = true;
  api.addEventListener("executed", event => {
    const detail = event.detail || {};
    const result = detail.output?.terrydirector_selflift_checkpoint?.[0];
    if (!result || typeof result.checkpoint_id !== "string") return;
    const node = app.graph?._nodes_by_id?.[detail.node];
    if (node?.comfyClass !== CLASS_NAME) return;

    const newId = result.checkpoint_id.trim();
    if (!/^[0-9a-f]{32}$/.test(newId)) return;
    const target = widget(node, "checkpoint_id");
    if (target && target.value !== newId) {
      target.value = newId;
      target.callback?.(newId);
    }
    const name = widget(node, "name");
    if (name && result.name && result.mode === "continued") {
      // "continue" may target a manually pasted ID. Reflect the real
      // checkpoint name only if it differs; do not edit model parameters.
      name.value = String(result.name).slice(0, 120);
    }
    node.properties ||= {};
    node.properties.tdLastSelfLiftCheckpoint = {
      checkpoint_id: newId,
      name: String(result.name || ""),
      mode: String(result.mode || ""),
    };
    refreshTitle(node);
    app.graph?.setDirtyCanvas?.(true, true);
  });
}

app.registerExtension({
  name: "TerryDirector.SelfLiftPauseResumeUI",
  async setup() {
    bindExecutionResult();
  },
  nodeCreated(node) {
    queueMicrotask(() => attach(node));
  },
  loadedGraphNode(node) {
    queueMicrotask(() => attach(node));
  },
});
