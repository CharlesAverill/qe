import * as sigma from 'sigma';
import 'graphology';
import 'graphologyLibrary';
import jsyaml from 'https://cdn.jsdelivr.net/npm/js-yaml@4.1.0/dist/js-yaml.mjs';

/* -----------------------------
   Color helpers
--------------------------------*/
const _clusterColorCache = new Map();

// Convert HSL to hex
function hslToHex(h, s, l) {
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
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619) >>> 0;
    }
    return h;
}

// Golden-angle color generator seeded by hash
function generateColorForLabel(label, toRead = false) {
    if (toRead) return "#EF4444";

    const GOLDEN_ANGLE = 137.50776405003785;
    const seed = hash32(String(label)) + hash32(String(label).split('').reverse().join(''));
    const offset = (seed % 360);
    const sat = 0.55 + ((seed >>> 8) % 20) / 100;
    const light = 0.48 + ((seed >>> 16) % 14) / 100;
    const index = ((seed >>> 24) & 0xff);
    const hue = (offset + index * GOLDEN_ANGLE) % 360;

    return hslToHex(hue, sat, light);
}

// Public function: deterministic, cached
function clusterColor(clusterLabel) {
    if (clusterLabel == null) return "#777777";
    const key = String(clusterLabel);
    if (_clusterColorCache.has(key)) return _clusterColorCache.get(key);
    const color = generateColorForLabel(key, clusterLabel == "ToRead");
    _clusterColorCache.set(key, color);
    return color;
}

/* -----------------------------
   UI Helper Functions
--------------------------------*/
function showPaperDetails(attributes) {
    const emptyState = document.getElementById('empty-state');
    const paperContent = document.getElementById('paper-content');
    
    emptyState.style.display = 'none';
    paperContent.style.display = 'block';
    
    // Update title and link
    const titleEl = document.getElementById('node-title');
    // titleEl.href = attributes.url;
    titleEl.textContent = attributes.label;
    
    // Update metadata
    document.getElementById('node-authors').textContent = attributes.authors.toString().replace(',', ', ') || 'N/A';
    document.getElementById('node-venue').textContent = attributes.conf || 'N/A';
    document.getElementById('node-year').textContent = attributes.year || 'N/A';
    
    // Update cluster
    const clusterDot = document.getElementById('cluster-dot');
    const clusterName = document.getElementById('node-cluster');
    const clusterColorVal = clusterColor(attributes.cluster);
    clusterDot.style.backgroundColor = clusterColorVal;
    clusterName.textContent = attributes.cluster || 'Uncategorized';
    clusterName.style.color = clusterColorVal;
    
    // Update notes
    const notesList = document.getElementById('node-notes');
    notesList.innerHTML = '';
    if (attributes.notes) {
        attributes.notes
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(line => line.length > 0)
            .forEach(line => {
                const li = document.createElement('li');
                li.textContent = line;
                notesList.appendChild(li);
            });
    }
    
    // Update read paper button
    const readBtn = document.getElementById('read-paper-btn');
    readBtn.href = attributes.url;
}

function populateLegend(graph) {
    const legendItems = document.getElementById('legend-items');
    legendItems.innerHTML = '';
    
    const clusters = new Set();
    graph.forEachNode((node, attr) => {
        if (attr.cluster) clusters.add(attr.cluster);
    });
    
    clusters.forEach(cluster => {
        const item = document.createElement('div');
        item.className = 'legend-item';
        
        const dot = document.createElement('div');
        dot.className = 'legend-dot';
        dot.style.backgroundColor = clusterColor(cluster);
        
        const label = document.createElement('span');
        label.textContent = cluster;
        
        item.appendChild(dot);
        item.appendChild(label);
        legendItems.appendChild(item);
    });
}

/* -----------------------------
   Main
--------------------------------*/
fetch("data/papers.yaml")
    .then(res => res.text())
    .then(yaml => {
        const data = jsyaml.load(yaml);
        const graph = new graphology.Graph({ type: 'directed' });

        // Nodes (add with initial size)
        if (data.nodes) {
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
        }

        // Edges
        if (data.edges) {
            data.edges.forEach(e => {
                e.to.forEach(to => {
                    graph.addEdge(e.from, to, { 
                        type: 'arrow', 
                        color: '#cbd5e1', 
                        size: 2, 
                        weight: 1
                    });
                });
            });

            // Check citation dates to ensure temporal consistency
            data.edges.forEach(e => {
                e.to.forEach(to => {
                    const fromAttr = graph.getNodeAttributes(e.from);
                    const toAttr = graph.getNodeAttributes(to);
                    if (fromAttr.year < toAttr.year) {
                        console.warn(
                            `Temporal violation: "${e.from}" (${fromAttr.year}) cites "${to}" (${toAttr.year})`
                        );
                    }
                });
            });
        }

        // Calculate node sizes based on out-degree (number of papers they cite)
        const inDegrees = {};
        let maxInDegree = 0;
        
        graph.forEachNode((node) => {
            const inDegree = graph.inDegree(node);
            inDegrees[node] = inDegree;
            maxInDegree = Math.max(maxInDegree, inDegree);
        });

        // Update node sizes based on citations (out-degree)
        // Size ranges from 4 (no citations) to 16 (most citations)
        const minSize = 4;
        const maxSize = 16;
        
        graph.forEachNode((node) => {
            const inDegree = inDegrees[node];
            let size;
            
            if (maxInDegree === 0) {
                size = minSize;
            } else {
                // Logarithmic scaling for better visual distribution
                const normalizedDegree = inDegree / maxInDegree;
                size = minSize + (maxSize - minSize) * Math.sqrt(normalizedDegree);
            }
            
            graph.setNodeAttribute(node, 'size', size);
        });

        // Create extra edges to pull cluster members together
        const clusterNodes = {};
        graph.forEachNode((node, attr) => {
            if (!clusterNodes[attr.cluster]) clusterNodes[attr.cluster] = [];
            clusterNodes[attr.cluster].push(node);
        });

        Object.values(clusterNodes).forEach(nodes => {
            for (let i = 0; i < nodes.length; i++) {
                for (let j = i + 1; j < nodes.length; j++) {
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
            if (ctr > 0) seedPapers.push(node);
            ctr--;
        });

        for (let i = 0; i < seedPapers.length; i++) {
            for (let j = i + 1; j < seedPapers.length; j++) {
                if (!graph.hasEdge(seedPapers[i], seedPapers[j])) {
                    graph.addEdge(seedPapers[i], seedPapers[j], { weight: 0.5, hidden: true });
                }
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

        // Hide loading overlay
        const loadingEl = document.getElementById('loading');
        loadingEl.classList.add('hidden');

        // Populate legend
        populateLegend(graph);

        /* -----------------------------
           Render
        --------------------------------*/
        const container = document.getElementById("graph-container");
        const renderer = new Sigma(graph, container, {
            renderEdgeLabels: false,
            defaultNodeColor: '#94a3b8',
            defaultEdgeColor: '#cbd5e1'
        });

        // Click handler
        renderer.on("clickNode", ({ node }) => {
            const attributes = graph.getNodeAttributes(node);
            showPaperDetails(attributes);
        });

        // Search functionality
        const searchInput = document.getElementById('search');
        searchInput.addEventListener('input', (e) => {
            const searchTerm = e.target.value.toLowerCase();
            
            if (!searchTerm) {
                // Reset all nodes to normal
                graph.forEachNode((node) => {
                    graph.setNodeAttribute(node, 'highlighted', false);
                    graph.setNodeAttribute(node, 'hidden', false);
                });
            } else {
                // Highlight matching nodes, dim others
                graph.forEachNode((node, attr) => {
                    const authorMatch = Array.isArray(attr.authors) 
                        ? attr.authors.some(author => author.toLowerCase().includes(searchTerm))
                        : (attr.authors && attr.authors.toLowerCase().includes(searchTerm));
                    
                    const matches = attr.label.toLowerCase().includes(searchTerm) ||
                                  authorMatch ||
                                  (attr.cluster && attr.cluster.toLowerCase().includes(searchTerm));
                    
                    graph.setNodeAttribute(node, 'highlighted', matches);
                    graph.setNodeAttribute(node, 'hidden', !matches);
                });
            }
            
            renderer.refresh();
        });

        // Control buttons
        document.getElementById('zoom-fit').addEventListener('click', () => {
            renderer.getCamera().animatedReset();
        });

        document.getElementById('reset-layout').addEventListener('click', () => {
            // Re-run layout
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
            renderer.refresh();
            renderer.getCamera().animatedReset();
        });
    })
    .catch(error => {
        console.error('Error loading graph:', error);
        const loadingEl = document.getElementById('loading');
        loadingEl.querySelector('p').textContent = 'Error loading graph data';
    });
