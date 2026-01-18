import * as sigma from 'sigma';
import 'graphology';
import 'graphologyLibrary';
import jsyaml from 'https://cdn.jsdelivr.net/npm/js-yaml@4.1.0/dist/js-yaml.mjs';

/* -----------------------------
   Color helpers
--------------------------------*/
// Color assignment using cached golden-angle hues seeded by a hash.
// Produces deterministic, well-spread hex colors for arbitrary labels.

const _clusterColorCache = new Map();

// Convert HSL to hex
function hslToHex(h, s, l) {
    // h in [0,360), s,l in [0,1]
    s = Math.max(0, Math.min(1, s));
    l = Math.max(0, Math.min(1, l));
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const hp = h / 60;
    const x = c * (1 - Math.abs((hp % 2) - 1));
    let [r1, g1, b1] = [0, 0, 0];
    if (0 <= hp && hp < 1) [r1, g1, b1] = [c, x, 0];
    else if (1 <= hp && hp < 2) [r1, g1, b1] = [x, c, 0];
    else if (2 <= hp && hp < 3) [r1, g1, b1] = [0, c, x];
    else if (3 <= hp && hp < 4) [r1, g1, b1] = [0, x, c];
    else if (4 <= hp && hp < 5) [r1, g1, b1] = [x, 0, c];
    else if (5 <= hp && hp < 6) [r1, g1, b1] = [c, 0, x];
    const m = l - c / 2;
    const r = Math.round((r1 + m) * 255);
    const g = Math.round((g1 + m) * 255);
    const b = Math.round((b1 + m) * 255);
    return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}

// Simple deterministic integer hash (32-bit)
function hash32(str) {
    let h = 2166136261 >>> 0; // FNV-1a 32-bit offset basis
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619) >>> 0;
    }
    return h;
}

function multilineToUL(text) {
  const ul = document.createElement("ul");

  text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .forEach(line => {
      const li = document.createElement("li");
      li.textContent = line;
      ul.appendChild(li);
    });

  return ul;
}

// Golden-angle color generator seeded by hash
function generateColorForLabel(label, toRead=false) {
    if (toRead)
        return "#FF0000";

    // golden angle in degrees
    const GOLDEN_ANGLE = 137.50776405003785;

    // seed from hash (0..2^32-1)
    const seed = hash32(String(label));

    // use low bits to pick an initial offset, then spread by golden angle
    const offset = (seed % 360); // 0..359
    // perturb saturation / lightness slightly from hash to avoid identical tones
    const sat = 0.55 + ((seed >>> 8) % 20) / 100; // 0.55..0.74
    const light = 0.48 + ((seed >>> 16) % 14) / 100; // 0.48..0.62

    // For better spread among many clusters, apply golden-angle offset multiplied
    // by a hashed index to avoid clustering near nearby hash seeds.
    const index = ((seed >>> 24) & 0xff); // 0..255
    const hue = (offset + index * GOLDEN_ANGLE) % 360;

    return hslToHex(hue, sat, light);
}

// Public function: deterministic, cached
function clusterColor(clusterLabel) {
    if (clusterLabel == null) return "#777777"; // fallback
    const key = String(clusterLabel);
    if (_clusterColorCache.has(key)) return _clusterColorCache.get(key);
    const color = generateColorForLabel(key, clusterLabel == "ToRead");
    _clusterColorCache.set(key, color);
    return color;
}


/* -----------------------------
   Main
--------------------------------*/
fetch("data/papers.yaml")
    .then(res => res.text())
    .then(yaml => {
        const data = jsyaml.load(yaml);
        const graph = new graphology.Graph({ type: 'directed' });

        // Nodes
        if (data.nodes)
            data.nodes.forEach(n => {
                graph.addNode(n.key, {
                    ...n,
                    cluster: n.cluster,
                    color: clusterColor(n.cluster),
                    size: n.size || 6,
                    x: n.x || Math.random(),
                    y: n.y || Math.random()
                });
            });

        // Edges
        if (data.edges)
            data.edges.forEach(e => {
                e.to.forEach(to => {
                    graph.addEdge(e.from, to, { type: 'arrow', color: '#888', size: 3, weight: 0.5 });
                });
            });

        // Create extra edges to pull cluster members together
        const clusterNodes = {};
        graph.forEachNode((node, attr) => {
            if (!clusterNodes[attr.cluster]) clusterNodes[attr.cluster] = [];
            clusterNodes[attr.cluster].push(node);
        });

        Object.values(clusterNodes).forEach(nodes => {
            // Fully connect cluster members with tiny-weight edges
            for (let i = 0; i < nodes.length; i++) {
                for (let j = i + 1; j < nodes.length; j++) {
                    // Only if an edge doesn’t exist already
                    if (!graph.hasEdge(nodes[i], nodes[j])) {
                        graph.addEdge(nodes[i], nodes[j], { weight: 1.0, hidden: true });
                    }
                }
            }
        });

        // Add cluster for seed papers
        const seedPapers = [];
        let ctr = 8;
        graph.forEachNode((node, attr) => {
            if (ctr > 0)
                seedPapers.push(node);
            ctr--;
        })

        for (let i = 0; i < seedPapers.length; i++) {
            for (let j = i + 1; j < seedPapers.length; j++) {
                if (!graph.hasEdge(seedPapers[i], seedPapers[j]))
                        graph.addEdge(seedPapers[i], seedPapers[j], { weight: 0.5, hidden: true });
            }
        }

        // Run ForceAtlas2
        graphologyLibrary.layoutForceAtlas2.assign(graph, {
            iterations: 200,
            settings: {
                gravity: 1,
                linLogMode: false,
                outboundAttractionDistribution: true,
                adjustSizes: false,
                strongGravityMode: false,
                scalingRatio: 5,
                slowDown: 3
            }
        });


        /* -----------------------------
           Render
        --------------------------------*/
        const container = document.getElementById("graph-container");
        const renderer = new Sigma(graph, container);

        // renderer.on("enterNode", ({ node }) => {
        //   renderer.setHighlightedNode(node);
        // });

        // renderer.on("leaveNode", () => {
        //   renderer.setHighlightedNode(null);
        // });

        renderer.on("clickNode", ({ node }) => {
            const a = graph.getNodeAttributes(node);
            console.log(a);
            document.getElementById("node-title").innerHTML = `<a href="${a.url}" target="_blank">${a.label}</a>`;
            document.getElementById("node-meta").innerHTML =
                `<p>
                    Authors: ${a.authors}
                    Venue: ${a.conf} ${a.year || ""}
                    Cluster: <span style="color: ${clusterColor(a.cluster)}">${a.cluster}</span>
                </p>`;
            document.getElementById("node-meta").appendChild(multilineToUL(a.notes));
        });

        // const searchInput = document.getElementById("search");
        // searchInput.addEventListener("input", e => {
        //     const q = e.target.value.toLowerCase();
        //     if (!q) return;

        //     const found = graph.nodes().find(
        //         n => graph.getNodeAttribute(n, "label").toLowerCase().includes(q)
        //     );
        //     if (!found) return;

        //     console.log(found);

        //     const cam = renderer.getCamera();
        //     const pos = graph.getNodeAttributes(found);
        //     cam.animate(
        //         { x: pos.x, y: pos.y, ratio: 0.2 },
        //         { duration: 500 }
        //     );

        //     console.log(pos);
        // });
    });
