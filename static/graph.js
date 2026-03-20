import * as d3 from 'd3';
import jsyaml from 'https://cdn.jsdelivr.net/npm/js-yaml@4.1.0/dist/js-yaml.mjs';

/* ─────────────────────────────────────────────
   Theme
───────────────────────────────────────────── */
const NODE_MIN       = 5;
const NODE_MAX       = 32;
const LABEL_SIZE     = 11;
const LABEL_MAX_W    = 120;
const LABEL_FONT     = `500 ${LABEL_SIZE}px "DM Mono", monospace`;
const LABEL_PAD_X    = 6;
const LABEL_PAD_Y    = 3;
const LABEL_LINE_H   = LABEL_SIZE * 1.3;  // line height for wrapped lines
const LABEL_GAP      = 5;
const LINK_BASE      = '#cbd5e1';
const LINK_HL        = '#6366f1';

// https://coolors.co/6366f1-10b981-ee7674-f59e0b-94a3b8
const CLUSTER_COLORS = {
    LLM           : '#6366f1',
    ClassicalML   : '#10b981',
    Algorithmic   : '#f59e0b',
    Environment   : '#EE7674',
    ToRead        : '#94a3b8',
};
function clusterColor(c) { return CLUSTER_COLORS[c] ?? '#94a3b8'; }

/* ─────────────────────────────────────────────
   Label wrapping
   Returns { lines: string[], lineW: number, totalH: number }
   where lineW is the width of the widest line (for the pill)
   and totalH is the full pill height including padding.
───────────────────────────────────────────── */
const _mCtx = document.createElement('canvas').getContext('2d');
_mCtx.font = LABEL_FONT;

function wrapLabel(text) {
    const maxInner = LABEL_MAX_W - LABEL_PAD_X * 2;  // available text width
    const words    = (text ?? '').split(/\s+/);
    const lines    = [];
    let   current  = '';

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

    const lineW  = Math.max(...lines.map(l => _mCtx.measureText(l).width));
    const pillW  = lineW + LABEL_PAD_X * 2;
    const pillH  = LABEL_PAD_Y * 2 + lines.length * LABEL_LINE_H;

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
        n.r      = NODE_MIN + (NODE_MAX - NODE_MIN) * Math.sqrt((inDeg.get(n.id) ?? 0) / maxDeg);
        const w  = wrapLabel(n.label ?? n.key);
        n.wrap   = w;           // { lines, pillW, pillH }
        n.labelW = w.pillW;     // used for collision radius
        n.labelH = w.pillH;     // used for zoom-to-fit bounding box
    });

    /* legend */
    buildLegend(nodes);

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
    const zoom  = d3.zoom().scaleExtent([0.08, 6])
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
    nodeG.each(function(d) {
        const g   = d3.select(this);
        const ly  = d.r + LABEL_GAP;
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
        .on('mouseenter', function(event, d) {
            d3.select(this).select('.label-bg')
                .attr('fill', '#eef2ff')
                .attr('stroke', '#a5b4fc');
            d3.select(this).select('.label-text').attr('fill', '#4338ca');
            d3.select(this).select('.node-circle').attr('fill-opacity', 0.28).attr('stroke-width', 2);
        })
        .on('mouseleave', function(event, d) {
            // only reset if node is not selected
            if (!d._selected) {
                d3.select(this).select('.label-bg').attr('fill', 'white').attr('stroke', '#e2e8f0');
                d3.select(this).select('.label-text').attr('fill', '#334155');
                d3.select(this).select('.node-circle').attr('fill-opacity', 1.0).attr('stroke-width', 1.5);
            }
        });

    /* ── Search ── */
    document.getElementById('search').addEventListener('input', e => {
        const term = e.target.value.trim().toLowerCase();
        nodeG.attr('opacity', d => {
            if (!term) return 1;
            const authorMatch = Array.isArray(d.authors)
                ? d.authors.some(a => a.toLowerCase().includes(term))
                : (d.authors ?? '').toLowerCase().includes(term);
            const hit = (d.label ?? '').toLowerCase().includes(term)
                     || authorMatch
                     || (d.cluster ?? '').toLowerCase().includes(term)
                     || String(d.year ?? '').includes(term)
                     || String(d.notes ?? '').toLowerCase().includes(term);
            console.log(String(d.label));
            console.log(d);
            console.log(String(d.notes).includes(term));
            console.log('=====');
            return hit ? 1 : 0.1;
        });
    });

    /* ── Zoom to fit ── */
    function zoomToFit(duration = 500) {
        const pad = 60;
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        nodes.forEach(n => {
            const left  = n.x - n.labelW / 2;
            const right = n.x + n.labelW / 2;
            const top   = n.y - n.r;
            const bot   = n.y + n.r + n.labelH + LABEL_GAP;
            if (left  < minX) minX = left;
            if (right > maxX) maxX = right;
            if (top   < minY) minY = top;
            if (bot   > maxY) maxY = bot;
        });
        const gW    = maxX - minX || 1;
        const gH    = maxY - minY || 1;
        const scale = Math.min((W - pad * 2) / gW, (H - pad * 2) / gH, 2);
        const tx    = W / 2 - scale * (minX + gW / 2);
        const ty    = H / 2 - scale * (minY + gH / 2);
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

    nodeG.attr('opacity', n => connected.has(n.id) ? 1 : 0.1);

    // highlight selected node pill
    nodeG.each(function(n) {
        if (n.id === d.id) {
            d3.select(this).select('.label-bg').attr('fill', '#eef2ff').attr('stroke', '#a5b4fc');
            d3.select(this).select('.label-text').attr('fill', '#4338ca');
            d3.select(this).select('.node-circle').attr('stroke-width', 2.5).attr('fill-opacity', 0.28);
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
    nodeG
        .attr('opacity', 1)
        .each(function() {
            d3.select(this).select('.label-bg').attr('fill', 'white').attr('stroke', '#e2e8f0');
            d3.select(this).select('.label-text').attr('fill', '#334155');
            d3.select(this).select('.node-circle').attr('stroke-width', 1.5).attr('fill-opacity', 1.0);
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
    document.getElementById('empty-state').style.display   = 'none';
    document.getElementById('paper-content').style.display = 'block';

    document.getElementById('node-title').textContent = d.label ?? d.key;

    const authors = Array.isArray(d.authors)
        ? d.authors.join(', ')
        : (d.authors ?? 'N/A');
    document.getElementById('node-authors').textContent = authors;
    document.getElementById('node-venue').textContent   = d.conf ?? 'N/A';
    document.getElementById('node-year').textContent    = d.year ?? 'N/A';

    const color = clusterColor(d.cluster);
    document.getElementById('cluster-dot').style.backgroundColor = color;
    const clusterNameEl = document.getElementById('node-cluster');
    clusterNameEl.textContent  = d.cluster ?? 'Uncategorized';
    clusterNameEl.style.color  = color;

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
    document.getElementById('empty-state').style.display   = 'flex';
    document.getElementById('paper-content').style.display = 'none';
}

/* ─────────────────────────────────────────────
   Legend
───────────────────────────────────────────── */
function buildLegend(nodes) {
    const clusters = [...new Set(nodes.map(n => n.cluster).filter(Boolean))];
    document.getElementById('legend-items').innerHTML = clusters.map(c => `
        <div class="legend-item">
            <div class="legend-dot" style="background:${clusterColor(c)}"></div>
            <span>${c}</span>
        </div>`
    ).join('');
}
