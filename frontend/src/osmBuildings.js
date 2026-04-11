/**
 * OpenStreetMap building data via Overpass + local geometry for map association.
 * Azimuth: 0° = north, clockwise (matches app bearing).
 */

import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import { point, polygon } from '@turf/helpers';

export const OSM_RAY_MAX_M = 160;
/** Beyond this distance along the azimuth ray, no building is linked. */
export const OSM_RAY_THRESHOLD_M = 95;
/** Radius (m) around each image coordinate used to query OSM ways for footprints + association. */
export const OSM_FETCH_BUFFER_M = 320;
/** Max `around:` clauses per Overpass request (avoid huge POST bodies). */
const MAX_AROUNDS_PER_REQUEST = 14;

const R_EARTH = 6371000;

function toLocalM(lat, lng, refLat, refLng) {
    const dLat = ((lat - refLat) * Math.PI) / 180;
    const dLng = ((lng - refLng) * Math.PI) / 180;
    const x = dLng * Math.cos((refLat * Math.PI) / 180) * R_EARTH;
    const y = dLat * R_EARTH;
    return { x, y };
}

/** Unit direction from azimuth (deg): 0=north, 90=east */
function azimuthToDirM(azDeg) {
    const r = (azDeg * Math.PI) / 180;
    return { x: Math.sin(r), y: Math.cos(r) };
}

/**
 * Ensure ring is closed for Leaflet / Turf (first point repeated at end if needed).
 * ring: [[lat,lng], ...]
 */
export function closeLatLngRing(ring) {
    if (!ring || ring.length < 3) return ring;
    const a = ring[0];
    const b = ring[ring.length - 1];
    if (a[0] !== b[0] || a[1] !== b[1]) return [...ring, ring[0]];
    return ring;
}

/** GeoJSON outer ring [lng,lat], closed. */
function ringToTurfCoords(ring) {
    const closed = closeLatLngRing(ring);
    if (!closed || closed.length < 4) return null;
    return closed.map(([la, ln]) => [ln, la]);
}

/**
 * Reliable point-in-building test (WGS84) using Turf.
 */
function haversineMeters(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLng = ((lng2 - lng1) * Math.PI) / 180;
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos((lat1 * Math.PI) / 180) *
            Math.cos((lat2 * Math.PI) / 180) *
            Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Keep buildings that overlap the analysis buffers (PIP or a ring vertex within range of a photo). */
export function filterBuildingsNearImagePoints(buildings, photoPoints, bufferM) {
    const slack = 220;
    const nearM = bufferM + slack;
    return buildings.filter((b) => {
        for (const p of photoPoints) {
            const plat = p.lat,
                plng = p.lng;
            if (pointInBuildingRingTurf(plat, plng, b.ring)) return true;
            const ring = closeLatLngRing(b.ring);
            for (let i = 0; i < ring.length - 1; i++) {
                if (haversineMeters(plat, plng, ring[i][0], ring[i][1]) <= nearM) return true;
            }
        }
        return false;
    });
}

function pointInBuildingRingTurf(lat, lng, ring) {
    const coords = ringToTurfCoords(ring);
    if (!coords || coords.length < 4) return false;
    try {
        const poly = polygon([coords]);
        const pt = point([lng, lat]);
        return booleanPointInPolygon(pt, poly);
    } catch {
        return false;
    }
}

/** Ray (ox,oy)+t*(dx,dy), t>=0; segment (ax,ay)-(bx,by). Returns t or null. */
function raySegmentHitT(ox, oy, dx, dy, ax, ay, bx, by) {
    const rdx = bx - ax,
        rdy = by - ay;
    const det = dx * rdy - dy * rdx;
    if (Math.abs(det) < 1e-12) return null;
    const t = ((ax - ox) * rdy - (ay - oy) * rdx) / det;
    const u = ((ax - ox) * dy - (ay - oy) * dx) / det;
    if (t >= 0 && u >= 0 && u <= 1) return t;
    return null;
}

/**
 * First distance along ray (meters) from point hitting polygon ring edges.
 */
export function rayHitRingDistanceM(lat0, lng0, azimuthDeg, ring) {
    if (!ring || ring.length < 2) return null;
    const refLat = lat0,
        refLng = lng0;
    const o = toLocalM(lat0, lng0, refLat, refLng);
    const dir = azimuthToDirM(azimuthDeg);
    const lr = closeLatLngRing(ring).map(([la, ln]) => toLocalM(la, ln, refLat, refLng));
    let best = Infinity;
    for (let i = 0; i < lr.length - 1; i++) {
        const j = i + 1;
        const t = raySegmentHitT(o.x, o.y, dir.x, dir.y, lr[i].x, lr[i].y, lr[j].x, lr[j].y);
        if (t != null && t >= 0 && t < best) best = t;
    }
    return best === Infinity ? null : best;
}

export function formatBuildingAddress(tags) {
    if (!tags) return '';
    const hn = tags['addr:housenumber'] || '';
    const st = tags['addr:street'] || tags['addr:place'] || '';
    const city = tags['addr:city'] || tags['addr:suburb'] || '';
    const parts = [];
    if (st || hn) parts.push([hn, st].filter(Boolean).join(' ').trim());
    if (city) parts.push(city);
    const line = parts.filter(Boolean).join(', ');
    if (line) return line;
    if (tags.name) return String(tags.name);
    return '';
}

/**
 * Parse Overpass JSON elements into buildings with outer rings (lat,lng), closed.
 */
export function parseOverpassBuildings(json) {
    const out = [];
    const els = json && json.elements ? json.elements : [];
    for (const el of els) {
        if (el.type !== 'way' || !el.geometry || el.geometry.length < 3) continue;
        const tags = el.tags || {};
        if (!tags.building) continue;
        const ring = closeLatLngRing(el.geometry.map((n) => [n.lat, n.lon]));
        out.push({
            osmId: el.id,
            tags,
            ring,
            addressLabel: formatBuildingAddress(tags)
        });
    }
    return out;
}

async function overpassQuery(body) {
    const res = await fetch('https://overpass-api.de/api/interpreter', {
        method: 'POST',
        body,
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' }
    });
    if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
    return res.json();
}

function mergeBuildingsByOsmId(lists) {
    const map = new Map();
    for (const list of lists) {
        for (const b of list) {
            if (b && b.osmId != null && !map.has(b.osmId)) map.set(b.osmId, b);
        }
    }
    return [...map.values()];
}

/**
 * Dedupe nearby points (same scene / burst) to keep Overpass queries smaller.
 * ~25 m buckets at mid-latitudes.
 */
export function dedupeImagePoints(points) {
    const seen = new Set();
    const out = [];
    for (const p of points) {
        const lat = Number(p.lat);
        const lng = Number(p.lng);
        if (Number.isNaN(lat) || Number.isNaN(lng)) continue;
        const k = `${lat.toFixed(3)},${lng.toFixed(3)}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ lat, lng });
    }
    return out;
}

function bboxAroundPointsMeters(points, bufferM) {
    if (!points.length) return null;
    let south = 90,
        west = 180,
        north = -90,
        east = -180;
    for (const p of points) {
        if (p.lat < south) south = p.lat;
        if (p.lat > north) north = p.lat;
        if (p.lng < west) west = p.lng;
        if (p.lng > east) east = p.lng;
    }
    const midLat = (south + north) / 2;
    const padLat = bufferM / 111320;
    const padLng = bufferM / (111320 * Math.cos((midLat * Math.PI) / 180) || 1e-6);
    return {
        south: south - padLat,
        west: west - padLng,
        north: north + padLat,
        east: east + padLng
    };
}

async function fetchBuildingsInBboxInternal(south, west, north, east) {
    const bbox = `${south},${west},${north},${east}`;
    const withRecurse = `[out:json][timeout:90];
(
  way["building"](${bbox});
);
(._;>;);
out geom;`;
    const simple = `[out:json][timeout:90];
(
  way["building"](${bbox});
);
out geom;`;
    try {
        return parseOverpassBuildings(await overpassQuery(withRecurse));
    } catch (e1) {
        console.warn('Overpass bbox (with recurse) failed, retrying simple:', e1);
        return parseOverpassBuildings(await overpassQuery(simple));
    }
}

/**
 * Fetch building ways whose geometry lies near image coordinates using Overpass `around:`.
 * Merges duplicate ways. Falls back to an expanded bbox if chunked queries fail.
 */
export async function fetchBuildingsForImagePoints(points, bufferM = OSM_FETCH_BUFFER_M) {
    const pts = dedupeImagePoints(points);
    if (!pts.length) return [];

    const runAroundChunk = async (chunk) => {
        const inner = chunk
            .map(({ lat, lng }) => `  way["building"](around:${bufferM},${lat},${lng});`)
            .join('\n');
        const q = `[out:json][timeout:120];
(
${inner}
);
(._;>;);
out geom;`;
        return parseOverpassBuildings(await overpassQuery(q));
    };

    const chunks = [];
    for (let i = 0; i < pts.length; i += MAX_AROUNDS_PER_REQUEST) {
        chunks.push(pts.slice(i, i + MAX_AROUNDS_PER_REQUEST));
    }

    const batchResults = [];
    for (const chunk of chunks) {
        try {
            batchResults.push(await runAroundChunk(chunk));
        } catch (e) {
            console.warn('Overpass around-chunk failed:', e);
            const bb = bboxAroundPointsMeters(chunk, bufferM);
            if (bb) {
                try {
                    const raw = await fetchBuildingsInBboxInternal(
                        bb.south,
                        bb.west,
                        bb.north,
                        bb.east
                    );
                    batchResults.push(filterBuildingsNearImagePoints(raw, chunk, bufferM));
                } catch (e2) {
                    console.warn('Overpass bbox fallback for chunk failed:', e2);
                }
            }
        }
    }

    let merged = mergeBuildingsByOsmId(batchResults);
    merged = filterBuildingsNearImagePoints(merged, pts, bufferM);

    if (merged.length === 0 && pts.length > 0) {
        const bb = bboxAroundPointsMeters(pts, bufferM);
        if (bb) {
            try {
                merged = filterBuildingsNearImagePoints(
                    await fetchBuildingsInBboxInternal(bb.south, bb.west, bb.north, bb.east),
                    pts,
                    bufferM
                );
            } catch (e) {
                console.warn('Overpass global bbox fallback failed:', e);
            }
        }
    }

    return merged;
}

/** @deprecated Prefer fetchBuildingsForImagePoints — kept for tests or manual bbox use */
export async function fetchBuildingsInBbox(south, west, north, east) {
    return fetchBuildingsInBboxInternal(south, west, north, east);
}

/**
 * For each photo, pick building: inside polygon (first by stable id) > nearest ray hit along azimuth (within thresholds) > orphan.
 * photos: array with latitude, longitude, azimuth?, image_id
 */
export function associatePhotosToBuildings(photos, buildings) {
    /** @type {Map<number, { osmId: number, addressLabel: string, ring: [number,number][], photos: object[] }>} */
    const groups = new Map();
    /** @type {Map<number, 'orphan' | number>} image_id -> osmId or 'orphan' */
    const imageToBuilding = new Map();

    const sortedBuildings = [...buildings].sort((a, b) => a.osmId - b.osmId);

    const withCoords = photos.filter(
        (p) =>
            p.latitude != null &&
            p.longitude != null &&
            !Number.isNaN(Number(p.latitude)) &&
            !Number.isNaN(Number(p.longitude))
    );

    for (const p of withCoords) {
        const plat = Number(p.latitude);
        const plng = Number(p.longitude);
        const az = p.azimuth != null && p.azimuth !== '' ? Number(p.azimuth) : NaN;
        let chosen = null;

        for (const b of sortedBuildings) {
            if (pointInBuildingRingTurf(plat, plng, b.ring)) {
                chosen = b;
                break;
            }
        }

        if (!chosen && !Number.isNaN(az)) {
            let bestB = null;
            let bestT = Infinity;
            for (const b of sortedBuildings) {
                const t = rayHitRingDistanceM(plat, plng, az, b.ring);
                if (t != null && t < bestT) {
                    bestT = t;
                    bestB = b;
                }
            }
            if (bestB && bestT <= OSM_RAY_MAX_M && bestT <= OSM_RAY_THRESHOLD_M) {
                chosen = bestB;
            }
        }

        if (!chosen) {
            imageToBuilding.set(p.image_id, 'orphan');
            continue;
        }

        imageToBuilding.set(p.image_id, chosen.osmId);
        if (!groups.has(chosen.osmId)) {
            groups.set(chosen.osmId, {
                osmId: chosen.osmId,
                addressLabel: chosen.addressLabel || '',
                ring: chosen.ring,
                photos: []
            });
        }
        groups.get(chosen.osmId).photos.push(p);
    }

    for (const g of groups.values()) {
        g.photos.sort((a, b) => (Number(a.image_id) || 0) - (Number(b.image_id) || 0));
    }

    return { groups, imageToBuilding };
}
