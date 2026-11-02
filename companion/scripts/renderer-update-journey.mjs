// Actual built Glass through the synthetic preview bridge; no game, agents or decisions.
export async function rendererUpdateJourney(page) {
  return page.evaluate(() => {
    const p = window.preview;
    const fullPreview = "Pending synthetic change.\n".repeat(400);
    p.model = { ...p.model, detail: { ...p.model.detail, entries: [
      { id: "update-assistant", kind: "assistant", text: "The old finished value.", streaming: false },
      { id: "update-tool", kind: "tool", name: "Synthetic read", text: "Tool result", output: "old output", status: "ok", expanded: true },
      { id: "update-approval", kind: "approval", title: "Synthetic request", text: fullPreview, approval: "pending", options: ["First"], requestId: "request-old" },
    ] } };
    p.emit("model", structuredClone(p.model));
    const nodes = [...document.querySelectorAll(".entry")];
    const html = document.getElementById("content").innerHTML;
    p.emit("model", structuredClone(p.model));
    const unchanged = nodes.every((node, i) => document.querySelectorAll(".entry")[i] === node)
      && document.getElementById("content").innerHTML === html;
    const pendingFull = document.querySelector(".approval-preview").textContent === fullPreview;
    p.model.detail.entries[0].text = "The new finished value.";
    p.model.detail.entries[1].output = "new output";
    p.model.detail.entries[2].options = ["Other"];
    p.model.detail.entries[2].requestId = "request-new";
    p.emit("model", structuredClone(p.model));
    const contentUpdated = document.querySelector(".entry.assistant").textContent.includes("new finished value")
      && document.querySelector(".tout").textContent === "new output";
    const option = [...document.querySelectorAll(".entry.approval [data-act]")]
      .map(node => JSON.parse(node.dataset.act)).find(action => action.type === "answer");
    const metadataUpdated = option?.label === "Other" && option.requestId === "request-new";
    p.model.detail.entries[2].approval = "denied";
    p.emit("model", structuredClone(p.model));
    return {
      unchanged_nodes_and_markup: unchanged,
      pending_preview_complete: pendingFull,
      same_length_content_and_output_updated: contentUpdated,
      approval_options_and_request_updated: metadataUpdated,
      resolved_approval_removes_decision_controls: document.querySelectorAll(".entry.approval .btns").length === 0
        && document.querySelector(".entry.approval .card-s").textContent.includes("Denied"),
      no_automatic_actions: p.calls.length === 0,
    };
  });
}
