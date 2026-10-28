/** D3 APIs used by the in-browser runtime (only active in HTML artifacts with JavaScript and the embedded d3 bundle). */
export const RUNTIME_D3_APIS = [
  "zoom",
  "zoom()",
  "zoom.scaleExtent",
  "zoom.on",
  "zoom.transform",
  "zoomIdentity",
  "brushX",
  "brush()",
  "brush.extent",
  "brush.on",
  "brush.move",
  "drag",
  "drag()",
  "drag.on",
  "quadtree",
  "quadtree.x",
  "quadtree.y",
  "quadtree.addAll",
  "quadtree.find",
  "selection.on",
  "selection.call",
];

/**
 * Browser runtime embedded in standalone HTML artifacts. Plain ES5-compatible JavaScript, no user-provided code.
 * Uses window.d3 (when embedded) for zoom, brush, drag and quadtree; tooltips, search, keyboard and linking are vanilla.
 */
export const RUNTIME_JS = String.raw`(function () {
  "use strict";
  var state = { errors: [], ready: false, charts: 0, selectedCat: null, timeRange: null, linkValues: null, linkLabel: null };
  window.__d3mcp = state;
  var hasD3 = typeof window.d3 !== "undefined";
  var tip = document.createElement("div");
  tip.className = "d3mcp-tooltip";
  tip.setAttribute("role", "tooltip");
  tip.id = "d3mcp-tooltip";
  tip.hidden = true;
  document.body.appendChild(tip);
  var live = document.createElement("div");
  live.className = "d3mcp-sr";
  live.setAttribute("aria-live", "polite");
  document.body.appendChild(live);

  function showTip(text, x, y) {
    if (!text) return;
    tip.textContent = text;
    tip.hidden = false;
    moveTip(x, y);
  }
  function moveTip(x, y) {
    var w = tip.offsetWidth, h = tip.offsetHeight;
    var left = Math.min(window.innerWidth - w - 8, x + 12);
    var top = y + 12 + h > window.innerHeight ? y - h - 12 : y + 12;
    tip.style.left = Math.max(4, left) + window.scrollX + "px";
    tip.style.top = Math.max(4, top) + window.scrollY + "px";
  }
  function hideTip() { tip.hidden = true; }
  window.addEventListener("resize", hideTip);
  function allMarks() { return Array.prototype.slice.call(document.querySelectorAll("svg.d3mcp-root .mark")); }
  function syncIcons() {
    document.querySelectorAll("svg.d3mcp-root g.node-icon").forEach(function (ic) {
      var svg = ic.ownerSVGElement, id = ic.getAttribute("data-id"), node = null;
      svg.querySelectorAll("circle.node").forEach(function (c) { if (c.getAttribute("data-id") === id) node = c; });
      ic.classList.toggle("dimmed", !!node && node.classList.contains("dimmed"));
    });
  }
  function clearStates() {
    allMarks().forEach(function (m) { m.classList.remove("dimmed", "selected", "linked"); });
  }
  function linkTokens(m) {
    var v = m.getAttribute("data-link");
    return v === null ? null : v.split("|");
  }
  function applyFilters() {
    var cat = state.selectedCat, tr = state.timeRange, lv = state.linkValues;
    var any = cat !== null || tr !== null || lv !== null;
    var n = 0;
    allMarks().forEach(function (m) {
      if (!any) { m.classList.remove("dimmed", "selected"); return; }
      var ok = true;
      if (cat !== null) ok = ok && m.getAttribute("data-cat") === cat;
      if (lv !== null) {
        var toks = linkTokens(m);
        if (toks === null) {
          if (cat === null && tr === null) { m.classList.remove("dimmed", "selected"); return; }
        } else {
          var hit = false;
          for (var i = 0; i < toks.length && !hit; i++) hit = lv[toks[i]] === true;
          ok = ok && hit;
        }
      }
      if (tr !== null && m.hasAttribute("data-t")) {
        var t = +m.getAttribute("data-t");
        ok = ok && t >= tr[0] && t <= tr[1];
      }
      m.classList.toggle("selected", ok);
      m.classList.toggle("dimmed", !ok);
      if (ok) n++;
    });
    live.textContent = any ? n + " marks selected" : "Selection cleared";
    state.selectedMarks = n;
    syncIcons();
    document.querySelectorAll(".d3mcp-filter").forEach(function (s) { s.value = cat === null ? "" : cat; });
    renderDetails();
  }
  state.highlightCategory = function (cat) { state.selectedCat = cat === state.selectedCat ? null : cat; applyFilters(); };
  state.setTimeRange = function (range) { state.timeRange = range; applyFilters(); };
  state.selectLink = function (tokens, label) {
    var key = tokens.slice().sort().join("|");
    if (state.linkKey === key) { state.linkValues = null; state.linkKey = null; state.linkLabel = null; }
    else {
      var set = {};
      tokens.forEach(function (t) { set[t] = true; });
      state.linkValues = set; state.linkKey = key; state.linkLabel = label || tokens.join(", ");
    }
    applyFilters();
  };
  state.reset = function () { state.selectedCat = null; state.timeRange = null; state.linkValues = null; state.linkKey = null; state.linkLabel = null; clearStates(); applyFilters(); };

  var linked = null;
  var linkedEl = document.getElementById("d3mcp-linked");
  if (linkedEl) { try { linked = JSON.parse(linkedEl.textContent); } catch (e) { state.errors.push("linked data: " + e.message); } }
  function renderDetails() {
    var panel = document.querySelector(".d3mcp-details");
    if (!panel || !linked) return;
    while (panel.firstChild) panel.removeChild(panel.firstChild);
    var lv = state.linkValues;
    var h = document.createElement("h2");
    h.style.fontSize = "15px";
    if (lv === null) {
      h.textContent = "Linked records";
      panel.appendChild(h);
      var p = document.createElement("p");
      p.className = "d3mcp-desc";
      p.textContent = "Click any bar, point, node, region or slice to select its " + linked.entity + " and see the matching records from every source. Click again or press Reset selection to clear.";
      panel.appendChild(p);
      state.detailRows = 0;
      return;
    }
    var label = state.linkLabel || "";
    h.textContent = "Linked records: " + (label.length > 120 ? label.slice(0, 117) + "…" : label);
    panel.appendChild(h);
    var total = 0;
    linked.sources.forEach(function (src) {
      var rows = src.rows.filter(function (r) { return lv[r._k] === true; });
      total += rows.length;
      var sh = document.createElement("h3");
      sh.textContent = src.label + " — " + rows.length + (rows.length === 1 ? " record" : " records") + (src.truncated ? " (first " + src.rows.length + " rows embedded)" : "");
      panel.appendChild(sh);
      if (!rows.length) return;
      var wrap = document.createElement("div");
      wrap.className = "d3mcp-table-wrap";
      var t = document.createElement("table");
      var thead = document.createElement("thead"), tr = document.createElement("tr");
      src.columns.forEach(function (c) { var th = document.createElement("th"); th.textContent = c; th.scope = "col"; tr.appendChild(th); });
      thead.appendChild(tr); t.appendChild(thead);
      var tb = document.createElement("tbody");
      rows.slice(0, 50).forEach(function (r) {
        var row = document.createElement("tr");
        src.columns.forEach(function (c) { var td = document.createElement("td"); var v = r[c]; td.textContent = v === null || v === undefined ? "" : String(v); row.appendChild(td); });
        tb.appendChild(row);
      });
      t.appendChild(tb); wrap.appendChild(t); panel.appendChild(wrap);
      if (rows.length > 50) { var more = document.createElement("p"); more.className = "d3mcp-desc"; more.textContent = "… and " + (rows.length - 50) + " more"; panel.appendChild(more); }
    });
    state.detailRows = total;
  }

  function initLinkSelect(svg) {
    if (!svg.hasAttribute("data-link-field")) return;
    svg.addEventListener("click", function (e) {
      var m = e.target.closest ? e.target.closest(".mark") : null;
      if (!m) return;
      var toks = linkTokens(m);
      if (!toks) return;
      state.selectLink(toks, m.getAttribute("data-label") || m.getAttribute("data-cat") || toks.join(", "));
    });
    svg.addEventListener("keydown", function (e) {
      if (e.key !== "Enter" && e.key !== " ") return;
      var m = document.activeElement;
      if (!m || !m.classList || !m.classList.contains("mark") || m.hasAttribute("data-cat")) return;
      var toks = linkTokens(m);
      if (toks) { state.selectLink(toks, m.getAttribute("data-label") || toks.join(", ")); e.preventDefault(); }
    });
  }

  function linkHover(key, on) {
    if (!key) return;
    allMarks().forEach(function (m) { if (m.getAttribute("data-key") === key) m.classList.toggle("linked", on); });
  }

  function initTooltips(svg) {
    if (svg.getAttribute("data-tooltip-enabled") === "false") return;
    svg.addEventListener("pointerover", function (e) {
      var m = e.target.closest ? e.target.closest(".mark") : null;
      if (!m) return;
      m.classList.add("hover");
      showTip(m.getAttribute("data-tooltip"), e.clientX, e.clientY);
      linkHover(m.getAttribute("data-key"), true);
    });
    svg.addEventListener("pointermove", function (e) { if (!tip.hidden) moveTip(e.clientX, e.clientY); });
    svg.addEventListener("pointerout", function (e) {
      var m = e.target.closest ? e.target.closest(".mark") : null;
      if (!m) return;
      m.classList.remove("hover");
      hideTip();
      linkHover(m.getAttribute("data-key"), false);
    });
    svg.addEventListener("focusin", function (e) {
      var m = e.target.closest ? e.target.closest(".mark") : null;
      if (!m) return;
      var r = m.getBoundingClientRect();
      showTip(m.getAttribute("data-tooltip"), r.left + r.width / 2, r.top + r.height / 2);
    });
    svg.addEventListener("focusout", hideTip);
  }

  function initKeyboard(svg) {
    var marks = Array.prototype.slice.call(svg.querySelectorAll(".mark[tabindex]"));
    svg.addEventListener("keydown", function (e) {
      var i = marks.indexOf(document.activeElement);
      if (i < 0) return;
      var next = null;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") next = marks[Math.min(marks.length - 1, i + 1)];
      else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = marks[Math.max(0, i - 1)];
      else if (e.key === "Home") next = marks[0];
      else if (e.key === "End") next = marks[marks.length - 1];
      else if (e.key === "Escape") { hideTip(); document.activeElement.blur(); }
      else if (e.key === "Enter" || e.key === " ") {
        var c = document.activeElement.getAttribute("data-cat");
        if (c !== null) { state.highlightCategory(c); e.preventDefault(); }
      }
      if (next) { next.focus(); e.preventDefault(); }
    });
  }

  function initLegend(svg) {
    Array.prototype.forEach.call(svg.querySelectorAll(".legend-item"), function (item) {
      item.setAttribute("tabindex", "0");
      item.setAttribute("role", "button");
      item.setAttribute("aria-label", "Highlight " + item.getAttribute("data-cat"));
      item.style.cursor = "pointer";
      var go = function () { state.highlightCategory(item.getAttribute("data-cat")); };
      item.addEventListener("click", go);
      item.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { go(); e.preventDefault(); } });
    });
  }

  function initZoom(svg) {
    if (!hasD3 || svg.getAttribute("data-zoom") !== "true") return;
    var d3 = window.d3;
    var vp = d3.select(svg).select(".d3mcp-viewport");
    var zoom = d3.zoom().scaleExtent([0.5, 24]).on("zoom", function (ev) { vp.attr("transform", ev.transform); hideTip(); });
    d3.select(svg).call(zoom).on("dblclick.zoom", null);
    svg.__d3mcpZoom = zoom;
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "d3mcp-btn";
    btn.textContent = "Reset zoom";
    btn.addEventListener("click", function () { d3.select(svg).call(zoom.transform, d3.zoomIdentity); });
    svg.parentNode.querySelector(".d3mcp-toolbar").appendChild(btn);
  }

  function initBrush(svg) {
    if (!hasD3 || svg.getAttribute("data-brush") !== "true") return;
    var d3 = window.d3;
    var plot = svg.querySelector(".plot");
    var w = +plot.getAttribute("data-inner-width"), h = +plot.getAttribute("data-inner-height");
    var g = d3.select(plot).append("g").attr("class", "brush");
    var brush = d3.brushX().extent([[0, 0], [w, h]]).on("end", function (ev) {
      if (!ev.selection) { state.timeRange = null; state.brushed = null; applyFilters(); return; }
      var x0 = ev.selection[0], x1 = ev.selection[1];
      var kind = plot.getAttribute("data-x-kind");
      var dom = plot.getAttribute("data-x-domain"), rng = plot.getAttribute("data-x-range");
      if (kind === "time" && dom && rng) {
        var d = JSON.parse(dom), r = JSON.parse(rng);
        var inv = function (px) { return d[0] + ((px - r[0]) / (r[1] - r[0])) * (d[1] - d[0]); };
        state.setTimeRange([inv(x0), inv(x1)]);
        return;
      }
      var ctm = plot.getScreenCTM();
      var sx0 = ctm.a * x0 + ctm.e, sx1 = ctm.a * x1 + ctm.e;
      var n = 0;
      Array.prototype.forEach.call(svg.querySelectorAll(".mark"), function (m) {
        var b = m.getBoundingClientRect();
        var cx = b.left + b.width / 2;
        var ok = cx >= sx0 && cx <= sx1;
        m.classList.toggle("selected", ok);
        m.classList.toggle("dimmed", !ok);
        if (ok) n++;
      });
      state.brushed = n;
      live.textContent = n + " marks selected";
    });
    g.call(brush);
    svg.__d3mcpBrush = brush;
  }

  function initDrag(svg) {
    if (!hasD3 || svg.getAttribute("data-drag") !== "true") return;
    var d3 = window.d3;
    var root = d3.select(svg);
    root.selectAll("circle.node").call(
      d3.drag().on("drag", function (ev) {
        var el = d3.select(this).attr("cx", ev.x).attr("cy", ev.y);
        var id = el.attr("data-id");
        root.selectAll("line.link").each(function () {
          var l = d3.select(this);
          if (l.attr("data-source") === id) l.attr("x1", ev.x).attr("y1", ev.y);
          if (l.attr("data-target") === id) l.attr("x2", ev.x).attr("y2", ev.y);
        });
        root.selectAll("text.node-label").each(function () {
          var t = d3.select(this);
          if (t.attr("data-id") !== id) return;
          if (t.attr("data-pos") === "below") t.attr("x", ev.x).attr("y", ev.y + (+el.attr("r")) + 11);
          else t.attr("x", ev.x + (+el.attr("r")) + 2).attr("y", ev.y + 3);
        });
        root.selectAll("g.node-icon").each(function () {
          var ic = d3.select(this);
          if (ic.attr("data-id") === id) ic.attr("transform", "translate(" + (ev.x + +ic.attr("data-dx")) + "," + (ev.y + +ic.attr("data-dy")) + ") scale(" + ic.attr("data-k") + ")");
        });
      })
    );
  }

  function initSearch(svg) {
    if (svg.getAttribute("data-search") !== "true") return;
    var input = document.createElement("input");
    input.type = "search";
    input.className = "d3mcp-search";
    input.placeholder = "Search labels…";
    input.setAttribute("aria-label", "Search marks by label");
    svg.parentNode.querySelector(".d3mcp-toolbar").appendChild(input);
    input.addEventListener("input", function () {
      var q = input.value.trim().toLowerCase();
      var n = 0;
      Array.prototype.forEach.call(svg.querySelectorAll(".mark"), function (m) {
        if (!q) { m.classList.remove("selected", "dimmed"); return; }
        var label = (m.getAttribute("data-label") || m.getAttribute("data-key") || "").toLowerCase();
        var ok = label.indexOf(q) !== -1;
        m.classList.toggle("selected", ok);
        m.classList.toggle("dimmed", !ok);
        if (ok) n++;
      });
      live.textContent = q ? n + " matches" : "Search cleared";
      syncIcons();
      state.searchMatches = n;
    });
  }

  function initCanvas(svg) {
    var id = svg.getAttribute("data-spec-id");
    var holder = document.getElementById("d3mcp-canvas-" + id);
    if (!holder) return;
    var cfg = JSON.parse(holder.textContent);
    var plot = svg.querySelector(".plot");
    Array.prototype.forEach.call(svg.querySelectorAll("path.point-cloud"), function (p) { p.setAttribute("visibility", "hidden"); });
    var wrap = svg.parentNode;
    var canvas = document.createElement("canvas");
    canvas.className = "d3mcp-canvas";
    canvas.setAttribute("aria-hidden", "true");
    wrap.appendChild(canvas);
    function draw() {
      var rect = svg.getBoundingClientRect(), wrapRect = wrap.getBoundingClientRect();
      var k = rect.width / cfg.width;
      var dpr = window.devicePixelRatio || 1;
      canvas.style.left = rect.left - wrapRect.left + "px";
      canvas.style.top = rect.top - wrapRect.top + "px";
      canvas.style.width = rect.width + "px";
      canvas.style.height = rect.height + "px";
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      var ctx = canvas.getContext("2d");
      ctx.setTransform(dpr * k, 0, 0, dpr * k, 0, 0);
      ctx.translate(cfg.left, cfg.top);
      ctx.globalAlpha = 0.7;
      for (var i = 0; i < cfg.points.length; i++) {
        var p = cfg.points[i];
        ctx.beginPath();
        ctx.fillStyle = p[3];
        ctx.arc(p[0], p[1], p[2], 0, 2 * Math.PI);
        ctx.fill();
      }
      canvas.__scale = k;
    }
    draw();
    window.addEventListener("resize", draw);
    if (hasD3) {
      var qt = window.d3.quadtree().x(function (p) { return p[0]; }).y(function (p) { return p[1]; }).addAll(cfg.points);
      svg.addEventListener("pointermove", function (e) {
        var ctm = plot.getScreenCTM().inverse();
        var pt = svg.createSVGPoint();
        pt.x = e.clientX; pt.y = e.clientY;
        var local = pt.matrixTransform(ctm);
        var found = qt.find(local.x, local.y, 8);
        if (found) showTip(found[4], e.clientX, e.clientY); else hideTip();
      });
    }
    state.canvasPoints = cfg.points.length;
  }

  function initDashboard() {
    var dash = document.querySelector("[data-dashboard]");
    if (!dash) return;
    var cats = {};
    allMarks().forEach(function (m) { var c = m.getAttribute("data-cat"); if (c !== null) cats[c] = true; });
    var names = Object.keys(cats).sort();
    var bar = dash.querySelector(".d3mcp-dashboard-controls");
    if (!bar) return;
    if (names.length && names.length <= 200) {
      var sel = document.createElement("select");
      sel.className = "d3mcp-filter";
      sel.setAttribute("aria-label", "Filter all charts by category");
      var o = document.createElement("option");
      o.value = ""; o.textContent = "All categories";
      sel.appendChild(o);
      names.forEach(function (n) { var op = document.createElement("option"); op.value = n; op.textContent = n; sel.appendChild(op); });
      sel.addEventListener("change", function () { state.selectedCat = sel.value === "" ? null : sel.value; applyFilters(); });
      bar.appendChild(sel);
    }
    var reset = document.createElement("button");
    reset.type = "button";
    reset.className = "d3mcp-btn";
    reset.textContent = "Reset selection";
    reset.addEventListener("click", function () {
      state.reset();
      if (hasD3) document.querySelectorAll("svg.d3mcp-root").forEach(function (s) { if (s.__d3mcpBrush) window.d3.select(s).select(".brush").call(s.__d3mcpBrush.move, null); });
    });
    bar.appendChild(reset);
  }

  try {
    var svgs = Array.prototype.slice.call(document.querySelectorAll("svg.d3mcp-root"));
    svgs.forEach(function (svg) {
      initTooltips(svg); initKeyboard(svg); initLegend(svg); initZoom(svg); initBrush(svg); initDrag(svg); initSearch(svg); initCanvas(svg); initLinkSelect(svg);
    });
    initDashboard();
    renderDetails();
    state.linked = !!linked;
    state.charts = svgs.length;
    state.d3 = hasD3;
    state.ready = true;
  } catch (err) {
    state.errors.push(String(err && err.message || err));
    throw err;
  }
})();`;
