import * as d3 from 'd3';
import jsyaml from 'https://cdn.jsdelivr.net/npm/js-yaml@4.1.0/dist/js-yaml.mjs';

/* ─────────────────────────────────────────────
   Theme
───────────────────────────────────────────── */
const NODE_MIN = 5;
const NODE_MAX = 32;
const LABEL_SIZE = 11;
const LABEL_MAX_W = 120;
const LABEL_FONT = `500 ${LABEL_SIZE}px "DM Mono", monospace`;
const LABEL_PAD_X = 6;
const LABEL_PAD_Y = 3;
const LABEL_LINE_H = LABEL_SIZE * 1.3;  // line height for wrapped lines
const LABEL_GAP = 5;
const LINK_BASE = '#cbd5e1';
const LINK_HL = '#6366f1';

/* ─────────────────────────────────────────────
   Label wrapping
   Returns { lines: string[], lineW: number, totalH: number }
   where lineW is the width of the widest line (for the pill)
   and totalH is the full pill height including padding.
───────────────────────────────────────────── */
const _mCtx = document.createElement('canvas').getContext('2d');
_mCtx.font = LABEL_FONT;

function lightenColor(hex, amount = 0.6) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    const blend = c => Math.round(c + (255 - c) * amount);
    return `rgb(${blend(r)}, ${blend(g)}, ${blend(b)})`;
}

function wrapLabel(text) {
    const maxInner = LABEL_MAX_W - LABEL_PAD_X * 2;  // available text width
    const words = (text ?? '').split(/\s+/);
    const lines = [];
    let current = '';

    for (const word of words) {
        const candidate = current ? current + ' ' + word : word;
        if (_mCtx.measureText(candidate).width <= maxInner) {
            current = candidate;
        } else {
            if (current) lines.push(current);
            // If a single word is wider than maxInner, let it overflow rather
            // than loop forever — just push it as its own line.
            current = word;
        }
    }
    if (current) lines.push(current);

    const lineW = Math.max(...lines.map(l => _mCtx.measureText(l).width));
    const pillW = lineW + LABEL_PAD_X * 2;
    const pillH = LABEL_PAD_Y * 2 + lines.length * LABEL_LINE_H;

    return { lines, pillW, pillH };
}

/* ─────────────────────────────────────────────
   Boot
───────────────────────────────────────────── */
fetch('/qe/data/papers.yaml')
    .then(r => r.text())
    .then(yaml => build(jsyaml.load(yaml)))
    .catch(err => {
        console.error(err);
        const el = document.getElementById('loading');
        if (el) el.querySelector('p').textContent = 'Failed to load data.';
    });

var clusters = [];

function clusterColor(cluster) {
    return clusters.filter(x => x.key == cluster)[0].color;
}

/* ─────────────────────────────────────────────
   Build
───────────────────────────────────────────── */
function build(data) {
    /* nodes */
    const nodeMap = new Map();
    const nodes = (data.nodes ?? []).map(n => {
        const node = { ...n, id: n.key };
        nodeMap.set(n.key, node);
        return node;
    });

    clusters = data.clusters;

    /* links + temporal check */
    const links = [];
    (data.edges ?? []).forEach(e => {
        (e.to ?? []).forEach(to => {
            if (!nodeMap.has(e.from) || !nodeMap.has(to)) return;
            const src = nodeMap.get(e.from);
            const tgt = nodeMap.get(to);
            if (src.year < tgt.year)
                console.warn(`Temporal violation: ${e.from}(${src.year}) → ${to}(${tgt.year})`);
            links.push({ source: e.from, target: to });
        });
    });

    /* size by in-degree */
    const inDeg = new Map(nodes.map(n => [n.id, 0]));
    links.forEach(l => inDeg.set(l.target, (inDeg.get(l.target) ?? 0) + 1));
    const maxDeg = Math.max(...inDeg.values(), 1);
    nodes.forEach(n => {
        n.r = NODE_MIN + (NODE_MAX - NODE_MIN) * Math.sqrt((inDeg.get(n.id) ?? 0) / maxDeg);
        const w = wrapLabel(n.label ?? n.key);
        n.wrap = w;           // { lines, pillW, pillH }
        n.labelW = w.pillW;     // used for collision radius
        n.labelH = w.pillH;     // used for zoom-to-fit bounding box
    });

    /* cluster meta from yaml */
    const clusterMeta = new Map((data.clusters ?? []).map(c => [c.key, c]));

    /* ── SVG ── */
    const container = document.getElementById('graph-container');
    let W = container.clientWidth;
    let H = container.clientHeight;

    const svg = d3.select(container).append('svg')
        .attr('width', '100%').attr('height', '100%');

    /* arrowhead markers */
    const defs = svg.append('defs');
    [['arrow', LINK_BASE], ['arrow-hl', LINK_HL]].forEach(([id, color]) => {
        defs.append('marker')
            .attr('id', id)
            .attr('viewBox', '0 -4 8 8')
            .attr('refX', 8).attr('refY', 0)
            .attr('markerWidth', 6).attr('markerHeight', 6)
            .attr('orient', 'auto')
            .append('path')
            .attr('d', 'M0,-4L8,0L0,4')
            .attr('fill', color);
    });

    /* zoom layer */
    const zoomG = svg.append('g');
    const zoom = d3.zoom().scaleExtent([0.08, 6])
        .on('zoom', e => zoomG.attr('transform', e.transform));
    svg.call(zoom);

    const linkLayer = zoomG.append('g');
    const nodeLayer = zoomG.append('g');

    /* ── Assign cluster anchor positions ──
       Arrange cluster centroids on a circle, then
       use forceX/forceY to pull each node toward its
       cluster's anchor. This is stable across the whole
       simulation lifecycle unlike a custom force. */
    const clusterKeys = [...new Set(nodes.map(n => n.cluster).filter(Boolean))];
    const clusterAnchor = new Map();
    const ANCHOR_R = Math.min(W, H) * 0.28;
    clusterKeys.forEach((c, i) => {
        const angle = (2 * Math.PI * i) / clusterKeys.length - Math.PI / 2;
        clusterAnchor.set(c, {
            x: W / 2 + ANCHOR_R * Math.cos(angle),
            y: H / 2 + ANCHOR_R * Math.sin(angle),
        });
    });

    /* Seed initial node positions near their cluster anchor
       so ForceAtlas doesn't have to fight from random positions */
    nodes.forEach(n => {
        const a = clusterAnchor.get(n.cluster);
        if (a) {
            n.x = a.x + (Math.random() - 0.5) * 80;
            n.y = a.y + (Math.random() - 0.5) * 80;
        }
    });

    /* ── Simulation ── */
    const sim = d3.forceSimulation(nodes)
        .force('link', d3.forceLink(links)
            .id(d => d.id)
            .distance(d => {
                const s = typeof d.source === 'object' ? d.source : nodeMap.get(d.source);
                const t = typeof d.target === 'object' ? d.target : nodeMap.get(d.target);
                return s?.cluster === t?.cluster ? 80 : 260;
            })
            .strength(d => {
                const s = typeof d.source === 'object' ? d.source : nodeMap.get(d.source);
                const t = typeof d.target === 'object' ? d.target : nodeMap.get(d.target);
                return s?.cluster === t?.cluster ? 0.5 : 0.1;
            }))
        .force('charge', d3.forceManyBody().strength(-300))
        .force('collide', d3.forceCollide()
            .radius(d => d.labelW / 2 + 18)
            .strength(1).iterations(6))
        .force('x', d3.forceX()
            .x(d => clusterAnchor.get(d.cluster)?.x ?? W / 2)
            .strength(0.25))
        .force('y', d3.forceY()
            .y(d => clusterAnchor.get(d.cluster)?.y ?? H / 2)
            .strength(0.25))
        .alphaDecay(0.022)
        .velocityDecay(0.38);

    /* ── Links ── */
    const linkSel = linkLayer.selectAll('line')
        .data(links).join('line')
        .attr('stroke', LINK_BASE)
        .attr('stroke-width', 1)
        .attr('marker-end', 'url(#arrow)');

    /* ── Node groups ── */
    const nodeG = nodeLayer.selectAll('g.node')
        .data(nodes, d => d.id)
        .join('g').attr('class', 'node-g')
        .style('cursor', 'pointer')
        .call(dragBehaviour(sim))
        .on('click', (event, d) => {
            event.stopPropagation();
            highlight(d, nodeG, linkSel);
            showSidebar(d, nodes, links, nodeMap);
        });

    /* circle */
    nodeG.append('circle')
        .attr('r', d => d.r)
        .attr('fill', d => clusterColor(d.cluster))
        // .attr('fill-opacity', 0.15)
        .attr('stroke', d => clusterColor(d.cluster))
        .attr('stroke-width', 1.5)
        .attr('class', 'node-circle');

    /* label pill background */
    nodeG.append('rect')
        .attr('class', 'label-bg')
        .attr('rx', 3)
        .attr('fill', 'white')
        .attr('stroke', '#e2e8f0')
        .attr('stroke-width', 0.75);

    /* label text — one <tspan> per wrapped line */
    nodeG.each(function (d) {
        const g = d3.select(this);
        const ly = d.r + LABEL_GAP;
        const { lines, pillW, pillH } = d.wrap;

        g.select('.label-bg')
            .attr('x', -pillW / 2).attr('y', ly)
            .attr('width', pillW).attr('height', pillH);

        const textEl = g.append('text')
            .attr('class', 'label-text')
            .attr('fill', '#334155')
            .attr('font-size', LABEL_SIZE)
            .attr('font-family', '"DM Mono", monospace')
            .attr('font-weight', 500)
            .attr('pointer-events', 'none')
            .attr('text-anchor', 'middle');

        lines.forEach((line, i) => {
            textEl.append('tspan')
                .attr('x', 0)
                .attr('y', ly + LABEL_PAD_Y + LABEL_SIZE + i * LABEL_LINE_H - 1)
                .text(line);
        });
    });

    /* ── Tick ── */
    sim.on('tick', () => {
        linkSel
            .attr('x1', d => d.source.x).attr('y1', d => d.source.y)
            .attr('x2', d => {
                const dx = d.target.x - d.source.x;
                const dy = d.target.y - d.source.y;
                const dist = Math.hypot(dx, dy) || 1;
                return d.target.x - (dx / dist) * (d.target.r + 10);
            })
            .attr('y2', d => {
                const dx = d.target.x - d.source.x;
                const dy = d.target.y - d.source.y;
                const dist = Math.hypot(dx, dy) || 1;
                return d.target.y - (dy / dist) * (d.target.r + 10);
            });
        nodeG.attr('transform', d => `translate(${d.x},${d.y})`);
    });

    /* ── Click background → deselect ── */
    svg.on('click', () => {
        clearHighlight(nodeG, linkSel);
        hideSidebar();
    });

    /* ── Hover glow ── */
    nodeG
        .on('mouseenter', function (event, d) {
            d3.select(this).select('.label-bg')
                .attr('fill', '#eef2ff')
                .attr('stroke', '#a5b4fc');
            d3.select(this).select('.label-text').attr('fill', '#4338ca');
            d3.select(this).select('.node-circle').attr('fill-opacity', 1).attr('stroke-width', 2);
        })
        .on('mouseleave', function (event, d) {
            if (!d._selected) {
                d3.select(this).select('.label-bg').attr('fill', 'white').attr('stroke', '#e2e8f0');
                d3.select(this).select('.label-text').attr('fill', '#334155');
                d3.select(this).select('.node-circle').attr('fill-opacity', 1.0).attr('stroke-width', 1.5);
            }
        });

    /* ── Legend (built here so nodeG/linkSel are in scope for cluster clicks) ── */
    buildLegend(nodes, clusterMeta, nodeG, linkSel, links, nodeMap);

    /* ── Search ── */
    document.getElementById('search').addEventListener('input', e => {
        const term = e.target.value.trim().toLowerCase();
        nodeG.each(function (d) {
            if (!term) {
                const baseColor = clusterColor(d.cluster);
                d3.select(this).attr('opacity', 1);
                d3.select(this).select('.node-circle').attr('stroke', baseColor).attr('fill', baseColor);
                d3.select(this).select('.label-bg').attr('fill', 'white').attr('stroke', '#e2e8f0');
                d3.select(this).select('.label-text').attr('fill', '#334155');
                return;
            }

            const authorMatch = Array.isArray(d.authors)
                ? d.authors.some(a => a.toLowerCase().includes(term))
                : (d.authors ?? '').toLowerCase().includes(term);
            const hit = (d.label ?? '').toLowerCase().includes(term)
                || authorMatch
                || (d.cluster ?? '').toLowerCase().includes(term)
                || String(d.year ?? '').includes(term)
                || String(d.notes ?? '').toLowerCase().includes(term);

            const baseColor = clusterColor(d.cluster);
            const dimmed = !hit;
            d3.select(this).select('.node-circle')
                .attr('stroke', dimmed ? lightenColor(baseColor) : baseColor)
                .attr('fill', dimmed ? lightenColor(baseColor) : baseColor);
            d3.select(this).select('.label-bg')
                .attr('fill', dimmed ? '#f8fafc' : 'white')
                .attr('stroke', '#e2e8f0');
            d3.select(this).select('.label-text')
                .attr('fill', dimmed ? '#cbd5e1' : '#334155');
        });
    });

    /* ── Zoom to fit ── */
    function zoomToFit(duration = 500) {
        const pad = 60;
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        nodes.forEach(n => {
            const left = n.x - n.labelW / 2;
            const right = n.x + n.labelW / 2;
            const top = n.y - n.r;
            const bot = n.y + n.r + n.labelH + LABEL_GAP;
            if (left < minX) minX = left;
            if (right > maxX) maxX = right;
            if (top < minY) minY = top;
            if (bot > maxY) maxY = bot;
        });
        const gW = maxX - minX || 1;
        const gH = maxY - minY || 1;
        const scale = Math.min((W - pad * 2) / gW, (H - pad * 2) / gH, 2);
        const tx = W / 2 - scale * (minX + gW / 2);
        const ty = H / 2 - scale * (minY + gH / 2);
        svg.transition().duration(duration)
            .call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(scale));
    }

    /* Auto-fit once the simulation has cooled */
    sim.on('end', () => zoomToFit(800));

    /* ── Controls ── */
    document.getElementById('zoom-fit').addEventListener('click', () => zoomToFit());
    document.getElementById('reset-layout').addEventListener('click', () => {
        nodes.forEach(n => { n.fx = null; n.fy = null; });
        clearHighlight(nodeG, linkSel);
        hideSidebar();
        sim.alpha(1).restart();
    });

    /* ── Resize ── */
    new ResizeObserver(() => {
        W = container.clientWidth;
        H = container.clientHeight;
        // Recompute cluster anchors for new viewport
        const newR = Math.min(W, H) * 0.28;
        clusterKeys.forEach((c, i) => {
            const angle = (2 * Math.PI * i) / clusterKeys.length - Math.PI / 2;
            clusterAnchor.set(c, {
                x: W / 2 + newR * Math.cos(angle),
                y: H / 2 + newR * Math.sin(angle),
            });
        });
        sim.force('x', d3.forceX().x(d => clusterAnchor.get(d.cluster)?.x ?? W / 2).strength(0.75));
        sim.force('y', d3.forceY().y(d => clusterAnchor.get(d.cluster)?.y ?? H / 2).strength(0.75));
        sim.alpha(0.3).restart();
    }).observe(container);

    document.getElementById('loading').classList.add('hidden');
}

/* ─────────────────────────────────────────────
   Drag — unpin on drop so graph re-settles
───────────────────────────────────────────── */
function dragBehaviour(sim) {
    return d3.drag()
        .on('start', (event, d) => {
            if (!event.active) sim.alphaTarget(0.3).restart();
            d.fx = d.x; d.fy = d.y;
        })
        .on('drag', (event, d) => { d.fx = event.x; d.fy = event.y; })
        .on('end', (event, d) => {
            if (!event.active) sim.alphaTarget(0);
            d.fx = null; d.fy = null;
        });
}

/* ─────────────────────────────────────────────
   Highlight on click
───────────────────────────────────────────── */
function nodeId(d) { return typeof d === 'object' ? d.id : d; }

function highlight(d, nodeG, linkSel) {
    // clear previous selection flag
    nodeG.each(n => { n._selected = false; });
    d._selected = true;

    const connected = new Set([d.id]);
    linkSel.each(l => {
        if (nodeId(l.source) === d.id) connected.add(nodeId(l.target));
        if (nodeId(l.target) === d.id) connected.add(nodeId(l.source));
    });

    nodeG.each(function (n) {
        const dimmed = !connected.has(n.id);
        const baseColor = clusterColor(n.cluster);
        d3.select(this).select('.node-circle')
            .attr('stroke', dimmed ? lightenColor(baseColor) : baseColor)
            .attr('fill', dimmed ? lightenColor(baseColor) : baseColor);
        d3.select(this).select('.label-bg')
            .attr('fill', dimmed ? '#f8fafc' : 'white')
            .attr('stroke', dimmed ? '#e2e8f0' : '#e2e8f0');
        d3.select(this).select('.label-text')
            .attr('fill', dimmed ? '#cbd5e1' : '#334155');
    });

    // highlight selected node pill
    nodeG.each(function (n) {
        if (n.id === d.id) {
            d3.select(this).select('.label-bg').attr('fill', '#eef2ff').attr('stroke', '#a5b4fc');
            d3.select(this).select('.label-text').attr('fill', '#4338ca');
            d3.select(this).select('.node-circle').attr('stroke-width', 2.5);
        }
    });

    linkSel
        .attr('stroke', l =>
            nodeId(l.source) === d.id || nodeId(l.target) === d.id ? LINK_HL : LINK_BASE)
        .attr('stroke-width', l =>
            nodeId(l.source) === d.id || nodeId(l.target) === d.id ? 2 : 1)
        .attr('marker-end', l =>
            nodeId(l.source) === d.id || nodeId(l.target) === d.id
                ? 'url(#arrow-hl)' : 'url(#arrow)');
}

function clearHighlight(nodeG, linkSel) {
    nodeG.each(n => { n._selected = false; });
    nodeG.attr('opacity', 1).each(function (n) {
        const baseColor = clusterColor(n.cluster);
        d3.select(this).select('.node-circle')
            .attr('fill', baseColor)
            .attr('stroke', baseColor)
            .attr('stroke-width', 1.5);
        d3.select(this).select('.label-bg').attr('fill', 'white').attr('stroke', '#e2e8f0');
        d3.select(this).select('.label-text').attr('fill', '#334155');
    });
    linkSel
        .attr('stroke', LINK_BASE)
        .attr('stroke-width', 1)
        .attr('marker-end', 'url(#arrow)');
}

/* ─────────────────────────────────────────────
   Sidebar — populates the existing HTML elements
───────────────────────────────────────────── */
function showSidebar(d, nodes, links, nodeMap) {
    document.getElementById('empty-state').style.display = 'none';
    document.getElementById('paper-content').style.display = 'block';
    document.getElementById('cluster-panel').style.display = 'none';

    document.getElementById('node-title').textContent = d.label ?? d.key;

    const authors = Array.isArray(d.authors)
        ? d.authors.join(', ')
        : (d.authors ?? 'N/A');
    document.getElementById('node-authors').textContent = authors;
    document.getElementById('node-venue').textContent = d.conf ?? 'N/A';
    document.getElementById('node-year').textContent = d.year ?? 'N/A';

    const color = clusterColor(d.cluster);
    document.getElementById('cluster-dot').style.backgroundColor = color;
    const clusterNameEl = document.getElementById('node-cluster');
    clusterNameEl.textContent = d.cluster ?? 'Uncategorized';
    clusterNameEl.style.color = color;

    /* notes */
    const notesList = document.getElementById('node-notes');
    notesList.innerHTML = '';
    const notesContainer = document.getElementById('notes-container');
    if (d.notes && d.notes.trim()) {
        notesContainer.style.display = 'block';
        d.notes.split(/\r?\n/).map(l => l.trim()).filter(Boolean).forEach(line => {
            const li = document.createElement('li');
            li.textContent = line;
            notesList.appendChild(li);
        });
    } else {
        notesContainer.style.display = 'none';
    }

    /* read paper button */
    const btn1 = document.getElementById('read-paper-btn');
    if (d.url) {
        btn1.href = d.url;
        btn1.style.display = 'flex';
    } else {
        btn1.style.display = 'none';
    }

    /* gscholar button */
    const btn2 = document.getElementById('gscholar-btn');
    if (d.url) {
        btn2.href = "https://scholar.google.com/scholar?q=" + encodeURIComponent(d.label);
        btn2.style.display = 'flex';
    } else {
        btn2.style.display = 'none';
    }
}

function hideSidebar() {
    document.getElementById('empty-state').style.display = 'flex';
    document.getElementById('paper-content').style.display = 'none';
    document.getElementById('cluster-panel').style.display = 'none';
}

/* ─────────────────────────────────────────────
   Legend — clicking a cluster highlights it and
   opens the cluster stats panel
───────────────────────────────────────────── */
function buildLegend(nodes, clusterMeta, nodeG, linkSel, links, nodeMap) {
    const clusters = [...new Set(nodes.map(n => n.cluster).filter(Boolean))]
        .filter(c => c !== 'ToRead');

    document.getElementById('legend-items').innerHTML = clusters.map(c => `
        <div class="legend-item" data-cluster="${c}" style="cursor:pointer">
            <div class="legend-dot" style="background:${clusterColor(c)}"></div>
            <span>${c}</span>
        </div>`
    ).join('');

    document.querySelectorAll('.legend-item[data-cluster]').forEach(el => {
        el.addEventListener('click', e => {
            e.stopPropagation();
            const c = el.dataset.cluster;
            highlightCluster(c, nodeG, linkSel);
            showClusterPanel(c, nodes, links, clusterMeta);
        });
    });
}

/* ─────────────────────────────────────────────
   Cluster highlight — dims everything outside
   the cluster and its cross-cluster edges
───────────────────────────────────────────── */
function highlightCluster(cluster, nodeG, linkSel) {
    nodeG.each(n => { n._selected = false; });

    const clusterNodeIds = new Set();
    nodeG.each(n => { if (n.cluster === cluster) clusterNodeIds.add(n.id); });

    nodeG.attr('opacity', 1).each(function (n) {
        const inCluster = n.cluster === cluster;
        const baseColor = clusterColor(n.cluster);
        d3.select(this).select('.node-circle')
            .attr('stroke', inCluster ? baseColor : lightenColor(baseColor))
            .attr('fill', inCluster ? baseColor : lightenColor(baseColor))
            .attr('stroke-width', inCluster ? 2.5 : 1.5);
        d3.select(this).select('.label-bg')
            .attr('fill', inCluster ? '#eef2ff' : '#f8fafc')
            .attr('stroke', inCluster ? '#a5b4fc' : '#e2e8f0');
        d3.select(this).select('.label-text')
            .attr('fill', inCluster ? '#4338ca' : '#cbd5e1');
    });

    linkSel
        .attr('stroke', l => {
            const sid = nodeId(l.source), tid = nodeId(l.target);
            return (clusterNodeIds.has(sid) || clusterNodeIds.has(tid)) ? LINK_HL : LINK_BASE;
        })
        .attr('stroke-width', l => {
            const sid = nodeId(l.source), tid = nodeId(l.target);
            return (clusterNodeIds.has(sid) || clusterNodeIds.has(tid)) ? 2 : 1;
        })
        .attr('marker-end', l => {
            const sid = nodeId(l.source), tid = nodeId(l.target);
            return (clusterNodeIds.has(sid) || clusterNodeIds.has(tid))
                ? 'url(#arrow-hl)' : 'url(#arrow)';
        });
}

/* ─────────────────────────────────────────────
   Cluster stats panel
───────────────────────────────────────────── */
function showClusterPanel(cluster, nodes, links, clusterMeta) {
    document.getElementById('empty-state').style.display = 'none';
    document.getElementById('paper-content').style.display = 'none';
    document.getElementById('cluster-panel').style.display = 'block';

    const color = clusterColor(cluster);
    const meta = clusterMeta.get(cluster) ?? {};
    const members = nodes.filter(n => n.cluster === cluster);
    const memberIds = new Set(members.map(n => n.id));

    /* header */
    const nameEl = document.getElementById('cluster-panel-name');
    nameEl.textContent = cluster;
    nameEl.style.color = color;
    document.getElementById('cluster-panel-dot').style.background = color;
    document.getElementById('cluster-panel-desc').textContent =
        meta.description ?? '';

    /* ── stats ── */

    // in-degree: edges coming INTO cluster nodes from anywhere
    let indegree = 0, outdegree = 0;
    links.forEach(l => {
        const sid = nodeId(l.source), tid = nodeId(l.target);
        if (memberIds.has(tid)) indegree++;
        if (memberIds.has(sid)) outdegree++;
    });

    // year range
    const years = members.map(n => n.year).filter(Boolean).sort((a, b) => a - b);
    const earliest = years[0] ?? '—';
    const latest = years[years.length - 1] ?? '—';

    // most common authors (only authors with > 1 paper in cluster)
    const authorCount = new Map();
    members.forEach(n => {
        const auths = Array.isArray(n.authors) ? n.authors : [];
        auths.forEach(a => authorCount.set(a, (authorCount.get(a) ?? 0) + 1));
    });
    const repeatAuthors = [...authorCount.entries()]
        .filter(([, count]) => count > 1)
        .sort((a, b) => b[1] - a[1]);

    document.getElementById('cluster-stat-indegree').textContent = indegree;
    document.getElementById('cluster-stat-outdegree').textContent = outdegree;
    document.getElementById('cluster-stat-papers').textContent = members.length;
    document.getElementById('cluster-stat-years').textContent =
        earliest === latest ? earliest : `${earliest} – ${latest}`;

    const authorsEl = document.getElementById('cluster-stat-authors-row');
    const authorsValEl = document.getElementById('cluster-stat-authors');
    if (repeatAuthors.length > 0) {
        authorsValEl.innerHTML = repeatAuthors
            .map(([a, n]) => `<span class="author-tag"><a href="https://scholar.google.com/citations?view_op=search_authors&mauthors=${a.replaceAll(" ", "+")}" target="_blank">${a}</a> <span class="author-count">(${n})</span></span>`)
            .join('');
        authorsEl.style.display = 'block';
    } else {
        authorsEl.style.display = 'none';
    }

    /* paper list */
    const listEl = document.getElementById('cluster-paper-list');
    listEl.innerHTML = '';
    members.sort((a, b) => (a.year ?? 0) - (b.year ?? 0)).forEach(n => {
        const li = document.createElement('li');
        li.innerHTML = `<span class="cp-year">${n.year ?? '?'}</span>
                        <span class="cp-title">${n.label ?? n.key}</span>`;
        listEl.appendChild(li);
    });
}
