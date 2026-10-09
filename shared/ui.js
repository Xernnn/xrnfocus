// Tiny DOM builders shared by the popup, the options page and the block page.
//
// These exist so that nothing user-authored ever reaches innerHTML. A site's
// label is editable on the options page, and rendering it as HTML would mean
// that whatever you typed there executes inside an extension page — which has
// chrome.* in scope. Building nodes and setting textContent removes the whole
// question, and takes addons-linter's UNSAFE_VAR_ASSIGNMENT warnings with it.
self.XrnFocus = self.XrnFocus || {};

(function (NS) {
  // Children may be nodes or plain strings, and a string has to become a text
  // node before appendChild will take it. Both el() and replace() go through
  // here so they cannot disagree about that — they did once, and replace()
  // threw on every string child it was handed.
  function append(node, children) {
    for (const c of [].concat(children === undefined ? [] : children)) {
      if (c === null || c === undefined || c === false) continue;
      node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return node;
  }

  // el("div", { class: "row", text: "hi" }, [childNode, "plain string"])
  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else node.setAttribute(k, v);
    }
    return append(node, children);
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function replace(node, children) {
    clear(node);
    return append(node, children);
  }

  // An uncapped site has no meaningful percentage; callers render those with
  // a muted fill rather than an empty bar.
  function pctOf(usedMs, capMinutes) {
    const capMs = (Number(capMinutes) || 0) * 60000;
    return capMs > 0 ? Math.min(100, (usedMs / capMs) * 100) : 0;
  }

  function track(pct, fillClass) {
    return el("div", { class: "track" }, [
      el("div", { class: ("fill " + (fillClass || "")).trim(), style: `width:${pct}%` })
    ]);
  }

  NS.ui = { el, append, clear, replace, pctOf, track };
})(self.XrnFocus);
