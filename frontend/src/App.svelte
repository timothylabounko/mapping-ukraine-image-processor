<svelte:head>
  <title>MU Image Collector</title>
</svelte:head>

<script>
import { writable, get } from 'svelte/store';
import { user, photos, editId } from './stores.js'; // ✅ added editId
import axios from 'axios';
import exifr from 'exifr';
import { onMount, tick } from 'svelte';
import * as L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import {
    fetchBuildingsForImagePoints,
    associatePhotosToBuildings,
    OSM_FETCH_BUFFER_M,
    OSM_RAY_THRESHOLD_M,
    OSM_RAY_MAX_M
} from './osmBuildings.js';
import JSZip from 'jszip';

let page = 'login';

// Login form
let email = '';
let password = '';

// Add/Edit form
let title = '';
let description = '';
let latitude = '';
let longitude = '';
let azimuth = '';
let file;
/** When editing a record that already has a file, URL to open in a new tab ("view current image"). */
let existingImageUrl = null;

const MAX_BULK_IMAGES = 500;
const BULK_IMAGE_EXT = /\.(jpe?g|png|gif|webp|bmp|tiff?|heic|heif)$/i;

let bulkFolderInput;
let bulkZipInput;
let bulkPendingFiles = [];
let bulkStatusText = '';
let bulkUploading = false;
let bulkUploadProgress = '';

function navigate(p) {
    if (page === 'add' && p !== 'add') {
        existingImageUrl = null;
    }
    if (p === 'bulk') {
        bulkPendingFiles = [];
        bulkStatusText = '';
        bulkUploading = false;
        bulkUploadProgress = '';
    }
    page = p;
    clearMapSelection();
    hoverArrowGroup = null;
    photoMarkersGroup = null;

    // cleanup dashboard map
    if (p !== 'map' && map) {
        map.off('zoomend', onDamageMapViewChange);
        map.off('moveend', onDamageMapViewChange);
        map.remove();
        map = null;
        buildingFootprintsGroup = null;
        photoMarkersGroup = null;
        damageBuildingImageModeGroup = null;
    }

    // cleanup add map
    if (p !== 'add' && addMap) {
        cancelAddAzimuthPick();
        addMap.remove();
        addMap = null;
    }
}

// Handle login
async function handleLogin() {
    try {
        const res = await axios.post('http://127.0.0.1:8000/api/login/', { 
            email: email.trim(),
            password
        });
        console.log('Login response:', res.data);
        if (res.data.user_id) {
            user.set(res.data);
            await fetchPhotos();
            navigate('main');
        } else {
            alert('Login failed: invalid response');
            console.error(res.data);
        }
    } catch (err) {
        console.error('Full error:', err);
        alert('Login failed: ' + formatApiError(err));
    }
}

// Fetch photos for logged-in user
async function fetchPhotos() {
    const $user = get(user);
    if (!$user) return;
    const res = await axios.get(`http://localhost:8000/api/images/?user_id=${$user.user_id}`);
    photos.set(res.data);
}

/** Strip HTML / noise; keep alerts short (no tracebacks, no code dumps). */
function sanitizeUserErrorText(s, maxLen) {
    let t = String(s)
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (t.length > maxLen) t = t.slice(0, maxLen - 1) + '…';
    return t;
}

function isServerDebugOrTraceback(text) {
    return (
        typeof text === 'string' &&
        (text.trim().startsWith('<!') ||
            /Traceback|ValueError at|SyntaxError at|File "[^"]+\.py|&#39;.*\.py/i.test(text))
    );
}

/** Short message for alert(); full details stay in console.error only. */
function formatApiError(err) {
    const res = err.response;
    const d = res?.data;
    const status = res?.status;

    if (typeof d === 'string' && isServerDebugOrTraceback(d)) {
        return status >= 500
            ? 'Something went wrong on the server. Please try again.'
            : 'The request could not be completed. Please try again.';
    }

    if (d == null || d === '') {
        if (status != null && status >= 500) return 'Something went wrong on the server. Please try again.';
        if (err.message === 'Network Error') return 'Could not reach the server.';
        return 'Could not complete the request. Please try again.';
    }

    if (typeof d === 'string') {
        return sanitizeUserErrorText(d, 280);
    }

    if (Array.isArray(d)) {
        return sanitizeUserErrorText(d.map(String).join('; '), 280);
    }

    if (typeof d === 'object') {
        if (d.detail !== undefined) {
            const det = d.detail;
            if (Array.isArray(det)) {
                const parts = det.map((e) =>
                    e && typeof e === 'object' && e.string !== undefined
                        ? String(e.string)
                        : typeof e === 'string'
                          ? e
                          : ''
                );
                const joined = parts.filter(Boolean).join('; ');
                if (isServerDebugOrTraceback(joined)) {
                    return 'Something went wrong on the server. Please try again.';
                }
                return sanitizeUserErrorText(joined || String(d.detail), 280);
            }
            const ds = String(det);
            if (isServerDebugOrTraceback(ds)) {
                return 'Something went wrong on the server. Please try again.';
            }
            return sanitizeUserErrorText(ds, 280);
        }
        if (d.error !== undefined) {
            return sanitizeUserErrorText(String(d.error), 280);
        }
        const lines = [];
        for (const [key, val] of Object.entries(d)) {
            if (key === 'traceback' || key === 'exc_info') continue;
            if (Array.isArray(val)) lines.push(`${key}: ${val.join(', ')}`);
            else if (val != null && typeof val === 'object') continue;
            else lines.push(`${key}: ${val}`);
        }
        return sanitizeUserErrorText(lines.join('; ') || 'Could not complete the request.', 280);
    }

    return 'Could not complete the request. Please try again.';
}

// Submit photo (add or edit)
async function submitPhoto() {
    const $user = get(user);
    const $editId = get(editId);

    const formData = new FormData();
    formData.append('title', title);
    formData.append('description', description);
    formData.append('latitude', latitude ? parseFloat(latitude) : '');
    formData.append('longitude', longitude ? parseFloat(longitude) : '');
    formData.append('azimuth', azimuth ? parseFloat(azimuth) : '');

    if (file) formData.append('file', file);
    formData.append('user', $user.user_id);

    try {
        if ($editId) {
            await axios.put(`http://localhost:8000/api/images/${$editId}/`, formData);
            editId.set(null);
        } else {
            await axios.post(`http://localhost:8000/api/images/`, formData);
        }
        fetchPhotos();
        navigate('main');
    } catch (err) {
        console.error('Submit photo error:', err.response?.data || err);
        alert('Could not submit photo: ' + formatApiError(err));
    }
}

// Prefill form for editing
function startEdit(photo) {
    title = photo.title;
    description = photo.description;
    latitude = photo.latitude;
    longitude = photo.longitude;
    azimuth = photo.azimuth;
    editId.set(photo.image_id);
    existingImageUrl = photo.file_url || null;
    file = undefined;
    navigate('add');
}

function openNewPhotoForm() {
    existingImageUrl = null;
    editId.set(null);
    title = '';
    description = '';
    latitude = '';
    longitude = '';
    azimuth = '';
    file = undefined;
    navigate('add');
}

// Delete photo
async function deletePhoto(id) {
    if (!confirm('Delete this photo?')) return;
    await axios.delete(`http://localhost:8000/api/images/${id}/`);
    fetchPhotos();
}

function isBulkImageFileByName(name) {
    if (!name || /\.svg$/i.test(name)) return false;
    return BULK_IMAGE_EXT.test(name);
}

function isBulkImageFile(file) {
    const name = file.name || '';
    if (/\.svg$/i.test(name)) return false;
    if (isBulkImageFileByName(name)) return true;
    if (file.type && file.type.startsWith('image/')) return true;
    return false;
}

async function extractImagesFromZip(zipFile) {
    const zip = await JSZip.loadAsync(zipFile);
    const out = [];
    const paths = Object.keys(zip.files).sort();
    for (const relPath of paths) {
        const entry = zip.files[relPath];
        if (entry.dir) continue;
        const base = relPath.split('/').pop() || relPath;
        if (!isBulkImageFileByName(base)) continue;
        const blob = await entry.async('blob');
        const file = new File([blob], base, {
            type: blob.type || 'application/octet-stream'
        });
        if (!isBulkImageFile(file)) continue;
        out.push(file);
        if (out.length >= MAX_BULK_IMAGES) break;
    }
    return out;
}

function onBulkFolderChange(ev) {
    const input = ev.currentTarget;
    const raw = Array.from(input.files || []);
    const imageCandidates = raw.filter(isBulkImageFile);
    const truncated = imageCandidates.length > MAX_BULK_IMAGES;
    const images = imageCandidates.slice(0, MAX_BULK_IMAGES);
    bulkPendingFiles = images;
    const skipped = raw.length - imageCandidates.length;
    let msg = `${images.length} image file(s) ready from folder.`;
    if (skipped > 0) msg += ` (${skipped} non-image file(s) skipped.)`;
    if (truncated) msg += ` Only the first ${MAX_BULK_IMAGES} images are included.`;
    bulkStatusText = msg;
    input.value = '';
}

async function onBulkZipChange(ev) {
    const input = ev.currentTarget;
    const f = input.files?.[0];
    input.value = '';
    if (!f) return;
    if (!/\.zip$/i.test(f.name)) {
        alert('Please choose a .zip file.');
        bulkStatusText = '';
        bulkPendingFiles = [];
        return;
    }
    bulkUploading = true;
    bulkStatusText = 'Reading ZIP…';
    try {
        const images = await extractImagesFromZip(f);
        bulkPendingFiles = images;
        bulkStatusText =
            images.length > 0
                ? `${images.length} image file(s) ready from ZIP.`
                : 'No image files found in this ZIP (only common image extensions are imported).';
    } catch (e) {
        console.error(e);
        alert('Could not read ZIP: ' + (e?.message || String(e)));
        bulkPendingFiles = [];
        bulkStatusText = '';
    } finally {
        bulkUploading = false;
    }
}

async function runBulkUpload() {
    const $user = get(user);
    if (!$user?.user_id) {
        alert('You must be logged in.');
        return;
    }
    if (!bulkPendingFiles.length) {
        alert('Choose a folder or a ZIP archive first. Only image files are imported.');
        return;
    }
    bulkUploading = true;
    let ok = 0;
    let fail = 0;
    const errs = [];
    const total = bulkPendingFiles.length;
    for (let i = 0; i < total; i++) {
        const file = bulkPendingFiles[i];
        bulkUploadProgress = `${i + 1} / ${total}`;
        const stem = file.name.replace(/\.[^/.]+$/, '').trim() || 'image';
        const safeTitle = stem.slice(0, 255);
        const formData = new FormData();
        formData.append('title', safeTitle);
        formData.append('description', 'Bulk import');
        formData.append('latitude', '');
        formData.append('longitude', '');
        formData.append('azimuth', '');
        formData.append('file', file);
        formData.append('user', $user.user_id);
        try {
            await axios.post('http://localhost:8000/api/images/', formData);
            ok++;
        } catch (err) {
            fail++;
            errs.push(`${file.name}: ${formatApiError(err)}`);
        }
    }
    bulkUploadProgress = '';
    bulkUploading = false;
    bulkPendingFiles = [];
    bulkStatusText = '';
    await fetchPhotos();
    if (fail === 0) {
        navigate('main');
    } else {
        const detail = errs.slice(0, 8).join('\n');
        alert(
            `Uploaded ${ok} image(s). Failed: ${fail}.\n\n${detail}${errs.length > 8 ? '\n…' : ''}`
        );
        if (ok > 0) navigate('main');
    }
}

// On mount, fetch photos if user already logged in
function onGlobalKeydown(ev) {
    if (ev.key === 'Escape') cancelAddAzimuthPick();
}

onMount(() => {
    if (get(user)) fetchPhotos();
    window.addEventListener('keydown', onGlobalKeydown);
    return () => window.removeEventListener('keydown', onGlobalKeydown);
});

let mapEl;        // dashboard map
let map;          // dashboard map instance
let photoMarkersGroup = null;
let buildingFootprintsGroup = null;
let damageBuildingImageModeGroup = null;
let hoverArrowGroup = null;
/** Building detail: `footprint` = OSM outline; `point` = current carousel image only (marker + azimuth). */
let damageMapBuildingViewMode = 'footprint';
let prevDamageMapBuildingOsmId = null;
/** Damage map: `{ type: 'building', osmId, idx }` | `{ type: 'orphan', photo }` | null */
let damageMapSelection = null;
let damageMapBuildings = [];
/** image_id → osm id (number) or 'orphan' */
let damagePhotoLink = {};
let damageMapOsmLoading = false;
let damageMapOsmError = null;
let lastDamageOsmKey = '';

let addMapEl;     // add/edit page map
let addMap;       // add/edit map instance
/** Add/Edit map: after double-clicking the pin, next map click sets azimuth (bearing from pin to click). */
let addAzimuthPickWaiting = false;
/** Line + arrowhead preview while moving the mouse in azimuth mode (Add/Edit map). */
let addAzimuthPreviewGroup = null;
/** Last cursor position while previewing (for redraw after zoom). */
let addAzimuthPreviewLastLat = null;
let addAzimuthPreviewLastLng = null;

/** Screen-size preview: stem + head length in CSS pixels (stable across zoom). */
const ADD_AZIMUTH_PREVIEW_STEM_PX = 68;
const ADD_AZIMUTH_PREVIEW_HEAD_LEN_PX = 11;
const ADD_AZIMUTH_PREVIEW_HEAD_HALF_W_PX = 5;

function addFormCoordsEmpty() {
    const empty = (v) =>
        v === '' || v == null || (typeof v === 'string' && v.trim() === '');
    return empty(latitude) && empty(longitude);
}

/** Single marker on add-map reflecting current latitude/longitude fields. */
function placeAddMapPin() {
    if (!addMap) return;
    const lat = parseFloat(latitude);
    const lng = parseFloat(longitude);
    if (Number.isNaN(lat) || Number.isNaN(lng)) return;
    addMap.eachLayer((layer) => {
        if (layer instanceof L.Marker) addMap.removeLayer(layer);
    });
    const marker = L.marker([lat, lng]).addTo(addMap);
    marker.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
    });
    marker.on('dblclick', (e) => {
        L.DomEvent.stopPropagation(e);
        if (Number.isNaN(lat) || Number.isNaN(lng)) return;
        addAzimuthPickWaiting = true;
        if (addMap) addMap.getContainer().style.cursor = 'crosshair';
        startAddAzimuthPreviewListeners();
    });
}

async function onAddPhotoFileChange(e) {
    const f = e.target.files?.[0];
    file = f;
    if (!f) return;
    if (!addFormCoordsEmpty()) return;

    try {
        const gps = await exifr.gps(f);
        if (gps && Number.isFinite(gps.latitude) && Number.isFinite(gps.longitude)) {
            latitude = Number(gps.latitude).toFixed(6);
            longitude = Number(gps.longitude).toFixed(6);
            await tick();
            placeAddMapPin();
            if (addMap) addMap.setView([Number(latitude), Number(longitude)], 14);
        }
    } catch (err) {
        console.warn('Could not read GPS from image', err);
    }
}

function hasAzimuth(p) {
    if (!p || p.azimuth == null || p.azimuth === '') return false;
    const a = Number(p.azimuth);
    return !Number.isNaN(a);
}

function displayVal(v) {
    if (v === null || v === undefined || v === '') return '—';
    return v;
}

function fmtDate(v) {
    if (v == null || v === '') return '—';
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return String(v);
    return d.toLocaleString();
}

function fmtMeta(v) {
    if (v == null || v === '') return '—';
    try {
        return JSON.stringify(v, null, 2);
    } catch {
        return String(v);
    }
}

function clearHoverArrow() {
    if (hoverArrowGroup && map) {
        map.removeLayer(hoverArrowGroup);
        hoverArrowGroup = null;
    }
}

/** Exit Add/Edit map “click direction for azimuth” mode. */
function cancelAddAzimuthPick() {
    addAzimuthPickWaiting = false;
    addAzimuthPreviewLastLat = null;
    addAzimuthPreviewLastLng = null;
    stopAddAzimuthPreviewListeners();
    clearAddAzimuthPreview();
    if (addMap && addMap.getContainer()) addMap.getContainer().style.cursor = '';
}

function clearDamageMapPane() {
    damageMapSelection = null;
    damageMapBuildingViewMode = 'footprint';
    clearHoverArrow();
    if (damageBuildingImageModeGroup && map) damageBuildingImageModeGroup.clearLayers();
}

function clearMapSelection() {
    clearDamageMapPane();
}

$: mapPanePhoto = (() => {
    if (!damageMapSelection) return null;
    if (damageMapSelection.type === 'orphan') return damageMapSelection.photo;
    const g = damageMapBuildings.find((b) => b.osmId === damageMapSelection.osmId);
    if (g && g.photos.length) {
        const i = Math.min(
            Math.max(0, damageMapSelection.idx),
            g.photos.length - 1
        );
        return g.photos[i];
    }
    return null;
})();

$: damageMapSelectedFootprint =
    damageMapSelection?.type === 'building'
        ? damageMapBuildings.find((b) => b.osmId === damageMapSelection.osmId) ?? null
        : null;

$: hasDamageSidePaneContent =
    mapPanePhoto != null ||
    (damageMapSelection?.type === 'building' && damageMapSelectedFootprint);

$: damageBuildingTitle =
    damageMapSelection?.type === 'building'
        ? (() => {
              const g = damageMapBuildings.find((b) => b.osmId === damageMapSelection.osmId);
              const fromGroup = g && (g.addressLabel || '').trim();
              if (fromGroup) return fromGroup;
              const f = damageMapSelectedFootprint;
              return (f?.addressLabel || '').trim() || 'Building with no address';
          })()
        : '';

$: damageCarouselGroup =
    damageMapSelection?.type === 'building'
        ? damageMapBuildings.find((b) => b.osmId === damageMapSelection.osmId)
        : null;

$: damageMapBuildingsSorted = [...damageMapBuildings].sort((a, b) => {
    const la = (a.addressLabel || '').trim().toLowerCase();
    const lb = (b.addressLabel || '').trim().toLowerCase();
    if (la !== lb) return la.localeCompare(lb);
    return a.osmId - b.osmId;
});

function zoomDamageMapToBuilding(osmId) {
    if (!map || page !== 'map') return;
    const g = damageMapBuildings.find((b) => b.osmId === osmId);
    if (!g?.ring?.length) return;
    const latlngs = g.ring.map(([lat, lng]) => L.latLng(lat, lng));
    const bounds = L.latLngBounds(latlngs);
    map.fitBounds(bounds, { padding: [32, 32], maxZoom: 18 });
    damageMapSelection = { type: 'building', osmId, idx: 0 };
    tick().then(() => {
        if (map) map.invalidateSize();
    });
}

async function loadDamageMapOsm() {
    if (page !== 'map' || !map) return;
    const list = get(photos) || [];
    const pts = list.filter(
        (p) =>
            p.latitude != null &&
            p.longitude != null &&
            !Number.isNaN(Number(p.latitude)) &&
            !Number.isNaN(Number(p.longitude))
    );
    const key = JSON.stringify(
        pts.map((p) => [p.image_id, p.latitude, p.longitude, p.azimuth])
    );
    if (key === lastDamageOsmKey) return;

    if (!pts.length) {
        damageMapBuildings = [];
        damagePhotoLink = {};
        damageMapOsmError = null;
        damageMapOsmLoading = false;
        lastDamageOsmKey = key;
        return;
    }

    const coords = pts.map((p) => ({
        lat: Number(p.latitude),
        lng: Number(p.longitude)
    }));
    damageMapOsmLoading = true;
    damageMapOsmError = null;
    try {
        const buildings = await fetchBuildingsForImagePoints(coords, OSM_FETCH_BUFFER_M);
        const { groups, imageToBuilding } = associatePhotosToBuildings(list, buildings);
        damageMapBuildings = Array.from(groups.values());
        damagePhotoLink = Object.fromEntries(
            [...imageToBuilding.entries()].map(([k, v]) => [String(k), v])
        );
        lastDamageOsmKey = key;
    } catch (e) {
        console.error('OSM buildings', e);
        damageMapOsmError = e.message || 'Could not load buildings';
        damageMapBuildings = [];
        damagePhotoLink = Object.fromEntries(pts.map((p) => [String(p.image_id), 'orphan']));
    } finally {
        damageMapOsmLoading = false;
    }
}

function prevDamageBuildingPhoto() {
    if (damageMapSelection?.type !== 'building') return;
    const g = damageMapBuildings.find((b) => b.osmId === damageMapSelection.osmId);
    if (!g || g.photos.length < 2) return;
    const n =
        (damageMapSelection.idx - 1 + g.photos.length) % g.photos.length;
    damageMapSelection = { type: 'building', osmId: damageMapSelection.osmId, idx: n };
}

function nextDamageBuildingPhoto() {
    if (damageMapSelection?.type !== 'building') return;
    const g = damageMapBuildings.find((b) => b.osmId === damageMapSelection.osmId);
    if (!g || g.photos.length < 2) return;
    const n = (damageMapSelection.idx + 1) % g.photos.length;
    damageMapSelection = { type: 'building', osmId: damageMapSelection.osmId, idx: n };
}

/** Initial bearing in degrees [0, 360) from (lat1,lng1) to (lat2,lng2), 0° = north. */
function bearingDegrees(lat1, lng1, lat2, lng2) {
    const φ1 = (lat1 * Math.PI) / 180;
    const φ2 = (lat2 * Math.PI) / 180;
    const Δλ = ((lng2 - lng1) * Math.PI) / 180;
    const y = Math.sin(Δλ) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
    const θ = Math.atan2(y, x);
    return ((θ * 180) / Math.PI + 360) % 360;
}

function clearAddAzimuthPreview() {
    if (addAzimuthPreviewGroup && addMap) {
        addMap.removeLayer(addAzimuthPreviewGroup);
    }
    addAzimuthPreviewGroup = null;
}

/**
 * Arrow in screen space: direction follows cursor from pin, length fixed in pixels so zoom does not resize it.
 */
function drawAddAzimuthPreview(plat, plng, cursorLat, cursorLng) {
    clearAddAzimuthPreview();
    if (!addMap) return;

    const pinLL = L.latLng(plat, plng);
    const cursorLL = L.latLng(cursorLat, cursorLng);
    const pinLayer = addMap.latLngToLayerPoint(pinLL);
    const cursorLayer = addMap.latLngToLayerPoint(cursorLL);

    let dx = cursorLayer.x - pinLayer.x;
    let dy = cursorLayer.y - pinLayer.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 1e-6) return;
    dx /= dist;
    dy /= dist;

    const stemEndLayer = L.point(
        pinLayer.x + dx * ADD_AZIMUTH_PREVIEW_STEM_PX,
        pinLayer.y + dy * ADD_AZIMUTH_PREVIEW_STEM_PX
    );
    const tipLayer = L.point(
        stemEndLayer.x + dx * ADD_AZIMUTH_PREVIEW_HEAD_LEN_PX,
        stemEndLayer.y + dy * ADD_AZIMUTH_PREVIEW_HEAD_LEN_PX
    );
    const perpX = -dy;
    const perpY = dx;
    const b1 = L.point(
        stemEndLayer.x + perpX * ADD_AZIMUTH_PREVIEW_HEAD_HALF_W_PX,
        stemEndLayer.y + perpY * ADD_AZIMUTH_PREVIEW_HEAD_HALF_W_PX
    );
    const b2 = L.point(
        stemEndLayer.x - perpX * ADD_AZIMUTH_PREVIEW_HEAD_HALF_W_PX,
        stemEndLayer.y - perpY * ADD_AZIMUTH_PREVIEW_HEAD_HALF_W_PX
    );

    const stemEndLL = addMap.layerPointToLatLng(stemEndLayer);
    const tipLL = addMap.layerPointToLatLng(tipLayer);
    const b1LL = addMap.layerPointToLatLng(b1);
    const b2LL = addMap.layerPointToLatLng(b2);

    const line = L.polyline([pinLL, stemEndLL], {
        color: '#fde047',
        weight: 2,
        opacity: 0.88
    });
    const head = L.polygon([tipLL, b1LL, b2LL], {
        color: '#fde047',
        fillColor: '#fde047',
        fillOpacity: 0.92,
        weight: 1
    });

    addAzimuthPreviewGroup = L.layerGroup([line, head]).addTo(addMap);
}

function onAddMapAzimuthMouseMove(e) {
    if (!addAzimuthPickWaiting || !addMap) return;
    const plat = parseFloat(latitude);
    const plng = parseFloat(longitude);
    if (Number.isNaN(plat) || Number.isNaN(plng)) return;
    addAzimuthPreviewLastLat = e.latlng.lat;
    addAzimuthPreviewLastLng = e.latlng.lng;
    drawAddAzimuthPreview(plat, plng, addAzimuthPreviewLastLat, addAzimuthPreviewLastLng);
}

function onAddMapAzimuthMouseOut() {
    addAzimuthPreviewLastLat = null;
    addAzimuthPreviewLastLng = null;
    clearAddAzimuthPreview();
}

function onAddMapAzimuthZoomEnd() {
    if (!addAzimuthPickWaiting || !addMap) return;
    if (addAzimuthPreviewLastLat == null || addAzimuthPreviewLastLng == null) return;
    const plat = parseFloat(latitude);
    const plng = parseFloat(longitude);
    if (Number.isNaN(plat) || Number.isNaN(plng)) return;
    drawAddAzimuthPreview(plat, plng, addAzimuthPreviewLastLat, addAzimuthPreviewLastLng);
}

function startAddAzimuthPreviewListeners() {
    if (!addMap) return;
    stopAddAzimuthPreviewListeners();
    addMap.on('mousemove', onAddMapAzimuthMouseMove);
    addMap.on('mouseout', onAddMapAzimuthMouseOut);
    addMap.on('zoomend', onAddMapAzimuthZoomEnd);
}

function stopAddAzimuthPreviewListeners() {
    if (!addMap) return;
    addMap.off('mousemove', onAddMapAzimuthMouseMove);
    addMap.off('mouseout', onAddMapAzimuthMouseOut);
    addMap.off('zoomend', onAddMapAzimuthZoomEnd);
}

function onAddMapClick(e) {
    if (addAzimuthPickWaiting) {
        const plat = parseFloat(latitude);
        const plng = parseFloat(longitude);
        if (Number.isNaN(plat) || Number.isNaN(plng)) {
            cancelAddAzimuthPick();
            return;
        }
        const brg = bearingDegrees(plat, plng, e.latlng.lat, e.latlng.lng);
        azimuth = Number(brg).toFixed(1);
        cancelAddAzimuthPick();
        return;
    }
    latitude = e.latlng.lat.toFixed(6);
    longitude = e.latlng.lng.toFixed(6);
    placeAddMapPin();
}

function toggleMapMarkerSelection(p) {
    if (mapPanePhoto != null && mapPanePhoto.image_id === p.image_id) {
        clearMapSelection();
        return;
    }
    const link = damagePhotoLink[String(p.image_id)];
    if (link === 'orphan' || link === undefined) {
        damageMapSelection = { type: 'orphan', photo: p };
    } else {
        const g = damageMapBuildings.find((b) => b.osmId === link);
        const idx = g ? g.photos.findIndex((ph) => ph.image_id === p.image_id) : 0;
        damageMapSelection = {
            type: 'building',
            osmId: link,
            idx: Math.max(0, idx)
        };
    }
}

function markerHoverTitle(p) {
    const t = p.title != null && String(p.title).trim() !== '' ? String(p.title).trim() : '';
    return t || '(No title)';
}

/** Sample offset in meters — only to get azimuth direction in screen space. */
const DAMAGE_ARROW_DIR_SAMPLE_M = 40;
const DAMAGE_ARROW_STEM_PX = 46;
const DAMAGE_ARROW_HEAD_LEN_PX = 8;
const DAMAGE_ARROW_HEAD_HALF_W_PX = 3.5;

function offsetByAzimuthMeters(lat, lng, azDeg, distM) {
    const br = (azDeg * Math.PI) / 180;
    const dym = Math.cos(br) * distM;
    const dxm = Math.sin(br) * distM;
    const dLat = dym / 111320;
    const dLng = dxm / (111320 * Math.cos((lat * Math.PI) / 180));
    return { lat: lat + dLat, lng: lng + dLng };
}

/** Screen-constant size (px): thin arrow; add to `group` (or hover overlay). */
function addDamageArrowLayersToGroup(photo, group) {
    if (!hasAzimuth(photo) || !map || !group) return;
    const az = Number(photo.azimuth);
    const lat = Number(photo.latitude);
    const lng = Number(photo.longitude);
    if (Number.isNaN(az) || Number.isNaN(lat) || Number.isNaN(lng)) return;

    const tipGeo = offsetByAzimuthMeters(lat, lng, az, DAMAGE_ARROW_DIR_SAMPLE_M);
    const o = map.latLngToLayerPoint(L.latLng(lat, lng));
    const tipRef = map.latLngToLayerPoint(L.latLng(tipGeo.lat, tipGeo.lng));
    let vx = tipRef.x - o.x;
    let vy = tipRef.y - o.y;
    const len = Math.sqrt(vx * vx + vy * vy);
    if (len < 1e-6) return;
    vx /= len;
    vy /= len;

    const stemEnd = L.point(o.x + vx * DAMAGE_ARROW_STEM_PX, o.y + vy * DAMAGE_ARROW_STEM_PX);
    const tipL = L.point(
        stemEnd.x + vx * DAMAGE_ARROW_HEAD_LEN_PX,
        stemEnd.y + vy * DAMAGE_ARROW_HEAD_LEN_PX
    );
    const px = -vy;
    const py = vx;
    const b1 = L.point(
        stemEnd.x + px * DAMAGE_ARROW_HEAD_HALF_W_PX,
        stemEnd.y + py * DAMAGE_ARROW_HEAD_HALF_W_PX
    );
    const b2 = L.point(
        stemEnd.x - px * DAMAGE_ARROW_HEAD_HALF_W_PX,
        stemEnd.y - py * DAMAGE_ARROW_HEAD_HALF_W_PX
    );

    const stemA = map.layerPointToLatLng(o);
    const stemB = map.layerPointToLatLng(stemEnd);
    const tLL = map.layerPointToLatLng(tipL);
    const b1LL = map.layerPointToLatLng(b1);
    const b2LL = map.layerPointToLatLng(b2);

    const line = L.polyline([stemA, stemB], {
        color: '#ca8a04',
        weight: 1.5,
        opacity: 0.92
    });
    const head = L.polygon([tLL, b1LL, b2LL], {
        color: '#ca8a04',
        fillColor: '#ca8a04',
        fillOpacity: 0.88,
        weight: 1
    });
    group.addLayer(line);
    group.addLayer(head);
}

function showHoverArrow(photo) {
    clearHoverArrow();
    if (!hasAzimuth(photo) || !map) return;
    hoverArrowGroup = L.layerGroup().addTo(map);
    addDamageArrowLayersToGroup(photo, hoverArrowGroup);
}

/** Current carousel image only: one marker + azimuth arrow (point mode). */
function redrawDamageBuildingPointModeLayers() {
    if (!map || !damageBuildingImageModeGroup) return;
    damageBuildingImageModeGroup.clearLayers();
    if (damageMapBuildingViewMode !== 'point' || damageMapSelection?.type !== 'building') return;
    const photo = getDamageMapPanePhotoResolved();
    if (!photo) return;
    const plat = Number(photo.latitude);
    const plng = Number(photo.longitude);
    if (Number.isNaN(plat) || Number.isNaN(plng)) return;
    const g = damageMapBuildings.find((b) => b.osmId === damageMapSelection.osmId);
    if (!g) return;
    const idx = Math.min(Math.max(0, damageMapSelection.idx), Math.max(0, g.photos.length - 1));
    const marker = L.marker([plat, plng]);
    marker.bindTooltip(markerHoverTitle(photo), {
        permanent: false,
        sticky: true,
        direction: 'top',
        offset: [0, -12],
        opacity: 1,
        className: 'damage-marker-tip'
    });
    marker.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
    });
    damageBuildingImageModeGroup.addLayer(marker);
    addDamageArrowLayersToGroup(photo, damageBuildingImageModeGroup);
}

/** Resolve selected pane photo without reading the `mapPanePhoto` reactive (avoids cycles with overlay refresh). */
function getDamageMapPanePhotoResolved() {
    if (!damageMapSelection) return null;
    if (damageMapSelection.type === 'orphan') return damageMapSelection.photo;
    const g = damageMapBuildings.find((b) => b.osmId === damageMapSelection.osmId);
    if (g && g.photos.length) {
        const i = Math.min(
            Math.max(0, damageMapSelection.idx),
            g.photos.length - 1
        );
        return g.photos[i];
    }
    return null;
}

function refreshDamageMapOverlays() {
    if (page !== 'map' || !map) return;
    if (damageMapSelection?.type === 'building') {
        const oid = damageMapSelection.osmId;
        if (prevDamageMapBuildingOsmId !== null && prevDamageMapBuildingOsmId !== oid) {
            damageMapBuildingViewMode = 'footprint';
        }
        prevDamageMapBuildingOsmId = oid;
    } else {
        prevDamageMapBuildingOsmId = null;
    }
    if (damageMapBuildingViewMode === 'point' && damageMapSelection?.type === 'building') {
        clearHoverArrow();
        redrawDamageBuildingPointModeLayers();
    } else {
        if (damageBuildingImageModeGroup) damageBuildingImageModeGroup.clearLayers();
        const pane = getDamageMapPanePhotoResolved();
        const buildingFootprintVisible =
            damageMapSelection?.type === 'building' &&
            damageMapBuildingViewMode === 'footprint';
        if (pane && hasAzimuth(pane) && !buildingFootprintVisible) showHoverArrow(pane);
        else clearHoverArrow();
    }
}

function onDamageMapViewChange() {
    if (page !== 'map' || !map) return;
    refreshDamageMapOverlays();
}

$: mapPointCount = ($photos || []).filter(
    (p) => p.latitude != null && p.longitude != null
).length;

$: if (page === 'map' && mapEl && !map) {
    map = L.map(mapEl).setView([48.3794, 31.1656], 6);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(map);
    buildingFootprintsGroup = L.layerGroup().addTo(map);
    photoMarkersGroup = L.layerGroup().addTo(map);
    damageBuildingImageModeGroup = L.layerGroup().addTo(map);
    map.on('zoomend', onDamageMapViewChange);
    map.on('moveend', onDamageMapViewChange);
    tick().then(() => {
        if (map) map.invalidateSize();
    });
}

$: if (page === 'map' && map) {
    $photos;
    loadDamageMapOsm();
}

$: if (page === 'map' && map) {
    damageMapSelection;
    damageMapBuildings;
    tick().then(() => refreshDamageMapOverlays());
} else {
    clearHoverArrow();
}

$: if (page === 'map' && map && photoMarkersGroup && buildingFootprintsGroup) {
    const plist = get(photos) || [];
    if (damageMapSelection) {
        if (damageMapSelection.type === 'orphan') {
            if (!plist.some((x) => x.image_id === damageMapSelection.photo.image_id)) {
                clearDamageMapPane();
            }
        } else {
            const g = damageMapBuildings.find((b) => b.osmId === damageMapSelection.osmId);
            if (!g) {
                clearDamageMapPane();
            } else {
                const stillValid = g.photos.some((pp) =>
                    plist.some((x) => x.image_id === pp.image_id)
                );
                if (!stillValid) clearDamageMapPane();
            }
        }
    }

    buildingFootprintsGroup.clearLayers();
    photoMarkersGroup.clearLayers();

    for (const b of damageMapBuildings) {
        if (
            damageMapBuildingViewMode === 'point' &&
            damageMapSelection?.type === 'building' &&
            damageMapSelection.osmId === b.osmId
        ) {
            continue;
        }
        const isSel =
            damageMapSelection?.type === 'building' && damageMapSelection.osmId === b.osmId;
        const poly = L.polygon(b.ring, {
            color: '#15803d',
            weight: isSel ? 4 : 2.5,
            opacity: 1,
            fillColor: '#22c55e',
            fillOpacity: isSel ? 0.32 : 0.14
        });
        poly.on('click', (e) => {
            L.DomEvent.stopPropagation(e);
            damageMapSelection = { type: 'building', osmId: b.osmId, idx: 0 };
        });
        poly.addTo(buildingFootprintsGroup);
    }

    (get(photos) || []).forEach((p) => {
        if (p.latitude == null || p.longitude == null) return;
        const plat = Number(p.latitude);
        const plng = Number(p.longitude);
        if (Number.isNaN(plat) || Number.isNaN(plng)) return;

        const link = damagePhotoLink[String(p.image_id)];
        if (link !== 'orphan') return;

        const marker = L.marker([plat, plng]).addTo(photoMarkersGroup);
        marker.bindTooltip(markerHoverTitle(p), {
            permanent: false,
            sticky: true,
            direction: 'top',
            offset: [0, -12],
            opacity: 1,
            className: 'damage-marker-tip'
        });
        marker.on('click', (e) => {
            L.DomEvent.stopPropagation(e);
            toggleMapMarkerSelection(p);
        });
    });

    tick().then(() => {
        if (map) map.invalidateSize();
    });
}

$: if (page === 'add' && addMapEl && !addMap) {
    addMap = L.map(addMapEl).setView([48.3794, 31.1656], 6);

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png")
        .addTo(addMap);

    addMap.on('click', onAddMapClick);

    tick().then(() => {
        placeAddMapPin();
        const lat = parseFloat(latitude);
        const lng = parseFloat(longitude);
        if (!Number.isNaN(lat) && !Number.isNaN(lng)) {
            addMap.setView([lat, lng], 14);
        }
        if (addMap) addMap.invalidateSize();
    });
}

</script>

<style>
/* Ukraine theme: blues + yellow accent */
:global(:root) {
    --uk-font: Arial, Helvetica, sans-serif;
    --uk-blue-bg: #0b1f3a;
    --uk-blue-header: #1e3a8a;
    --uk-blue-card: #132c4c;
    --uk-blue-map-inner: #0f172a;
    --uk-yellow: #facc15;
    --uk-yellow-hover: #fde047;
    --uk-text: #f1f5f9;
    --uk-text-muted: #94a3b8;
    --uk-border-table: #334155;
}

html, body {
    margin: 0;
    padding: 0;
    width: 100%;
    overflow-x: hidden;
    font-family: var(--uk-font);
    background: var(--uk-blue-bg);
    color: var(--uk-text);
}
.header {
    position: fixed;
    top: 0;
    left: 0;
    width: 100vw;
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px 20px;
    background: var(--uk-blue-header);
    border-bottom: 3px solid var(--uk-yellow);
    box-sizing: border-box;
    z-index: 1000;
}
.main-content {
    margin-top: 64px;
}
.main-content--map {
    margin-top: 64px;
    width: 100%;
    max-width: 100%;
    height: calc(100vh - 64px);
    display: flex;
    flex-direction: column;
    padding: 0;
    margin-left: 0;
    margin-right: 0;
    overflow: hidden;
    box-sizing: border-box;
}
.map-layout {
    flex: 1;
    display: flex;
    flex-direction: row;
    align-items: stretch;
    min-height: 0;
    width: 100%;
}
.map-main-column {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
}
.map-head {
    flex-shrink: 0;
    width: 100%;
    padding: 14px 16px 16px;
    box-sizing: border-box;
    background: #fff;
    text-align: center;
}
.map-head .page-title {
    margin: 0 0 8px 0;
    padding: 0;
    background: transparent;
    border-radius: 0;
    color: #000;
    text-align: center;
}
.map-head .page-intro {
    color: #334155;
    text-align: center;
}
.map-osm-status {
    margin: 8px 0 0 0;
    font-size: 0.8rem;
    line-height: 1.35;
}
.map-osm-status--loading {
    color: #475569;
}
.map-osm-status--error {
    color: #b91c1c;
}
.map-building-pane-title {
    margin: 0 0 10px 0;
    padding: 0 36px 0 0;
    font-size: 1rem;
    font-weight: 700;
    color: var(--uk-text);
    line-height: 1.3;
}
.map-photo-carousel {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    margin: 0 0 14px 0;
}
.map-carousel-btn {
    background: var(--uk-yellow);
    color: #000;
    border: none;
    width: 32px;
    height: 32px;
    border-radius: 6px;
    font-size: 1.2rem;
    line-height: 1;
    cursor: pointer;
    font-weight: bold;
}
.map-carousel-btn:hover {
    background: var(--uk-yellow-hover);
}
.map-carousel-count {
    font-size: 0.85rem;
    color: var(--uk-text-muted);
}
.map-side-no-address-banner {
    margin: 0 0 12px 0;
    padding: 8px 10px;
    font-size: 0.88rem;
    line-height: 1.35;
    color: var(--uk-text);
    background: rgba(250, 204, 21, 0.1);
    border: 1px solid rgba(250, 204, 21, 0.35);
    border-radius: 6px;
}
.map-side-pane {
    flex: 0 0 clamp(280px, 32vw, 380px);
    align-self: stretch;
    min-height: 0;
    position: relative;
    background: var(--uk-blue-card);
    border-right: 3px solid var(--uk-yellow);
    overflow-y: auto;
    overflow-x: hidden;
    padding: 12px;
    box-sizing: border-box;
    font-family: var(--uk-font);
}
.map-side-pane--has-selection {
    padding-top: 44px;
}
.map-side-pane-header {
    position: absolute;
    top: 8px;
    right: 8px;
    z-index: 6;
}
.map-side-close {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    padding: 0;
    margin: 0;
    border: none;
    border-radius: 6px;
    cursor: pointer;
    background: rgba(0, 0, 0, 0.35);
    color: var(--uk-yellow);
    line-height: 1;
    transition: background 0.15s ease, color 0.15s ease;
}
.map-side-close:hover {
    background: rgba(250, 204, 21, 0.2);
    color: #fff;
}
.map-side-close-icon {
    font-size: 1.5rem;
    font-weight: bold;
    margin-top: -2px;
}
.map-side-pane h3 {
    margin: 12px 0 8px 0;
    font-size: 1.05rem;
    color: var(--uk-text);
}
.map-side-placeholder {
    margin: 0;
    color: var(--uk-text-muted);
    font-size: 0.9rem;
    line-height: 1.45;
}
.map-side-pane-toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    margin: 10px 0 14px 0;
}
.map-side-edit-btn {
    font-size: 0.85rem;
    padding: 7px 14px;
}
.map-side-view-mode-btn {
    font-size: 0.8rem;
    padding: 7px 12px;
    background: rgba(34, 197, 94, 0.2);
    color: var(--uk-text);
    border: 1px solid rgba(34, 197, 94, 0.55);
}
.map-side-view-mode-btn:hover {
    background: rgba(34, 197, 94, 0.32);
}
.map-side-view-mode-btn--active {
    background: rgba(250, 204, 21, 0.22);
    border-color: var(--uk-yellow);
    color: var(--uk-yellow);
    font-weight: 700;
}
.map-side-view-mode-btn--active:hover {
    background: rgba(250, 204, 21, 0.3);
}
.map-building-list-heading {
    margin: 16px 0 8px 0;
    padding: 0;
    font-size: 0.8rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--uk-yellow);
}
.map-building-list {
    margin: 0;
    padding: 0;
    list-style: none;
}
.map-building-list-item + .map-building-list-item {
    margin-top: 6px;
}
.map-building-list-btn {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    width: 100%;
    margin: 0;
    padding: 10px 12px;
    box-sizing: border-box;
    text-align: left;
    font-family: inherit;
    font-size: 0.9rem;
    line-height: 1.35;
    color: var(--uk-text);
    background: rgba(34, 197, 94, 0.12);
    border: 1px solid rgba(34, 197, 94, 0.45);
    border-radius: 8px;
    cursor: pointer;
    transition: background 0.15s ease, border-color 0.15s ease;
}
.map-building-list-btn:hover {
    background: rgba(34, 197, 94, 0.2);
    border-color: rgba(34, 197, 94, 0.75);
}
.map-building-list-btn:focus-visible {
    outline: 2px solid var(--uk-yellow);
    outline-offset: 2px;
}
.map-building-list-title {
    font-weight: 600;
    color: var(--uk-text);
}
.map-building-list-meta {
    font-size: 0.78rem;
    color: var(--uk-text-muted);
}
.add-azimuth-hint {
    margin: 0 0 10px 0;
    padding: 10px 12px;
    background: rgba(250, 204, 21, 0.12);
    border: 1px solid var(--uk-yellow);
    border-radius: 6px;
    font-size: 0.9rem;
    line-height: 1.4;
    color: var(--uk-text);
}
.map-side-img-bleed {
    margin-left: -12px;
    margin-right: -12px;
    width: calc(100% + 24px);
    max-width: calc(100% + 24px);
    box-sizing: border-box;
}
.map-side-img {
    display: block;
    width: 100%;
    max-height: 220px;
    object-fit: contain;
    border-radius: 0;
    border: none;
    border-top: 1px solid var(--uk-border-table);
    border-bottom: 1px solid var(--uk-border-table);
    background: #0f172a;
    box-sizing: border-box;
}
.map-side-field {
    margin-top: 10px;
    font-size: 0.88rem;
    color: var(--uk-text);
    line-height: 1.4;
}
.map-side-pane > .map-side-field:first-child {
    margin-top: 0;
}
.map-side-label {
    display: block;
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--uk-yellow);
    margin-bottom: 4px;
}
.map-side-meta {
    margin: 0;
    padding: 8px;
    font-size: 0.75rem;
    line-height: 1.35;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--uk-text);
    background: rgba(0, 0, 0, 0.25);
    border-radius: 6px;
    max-height: 180px;
    overflow: auto;
}
.map-side-link {
    color: var(--uk-yellow-hover);
    word-break: break-all;
}
.map-embed {
    flex: 1;
    min-height: 0;
    width: 100%;
    background: var(--uk-blue-map-inner);
}

/* Leaflet hover title on map points */
:global(.leaflet-tooltip.damage-marker-tip) {
    padding: 7px 11px !important;
    background: #fff !important;
    color: #0f172a !important;
    border: 1px solid var(--uk-border-table) !important;
    border-radius: 8px !important;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.22) !important;
    font-weight: bold !important;
    font-size: 12px !important;
    line-height: 1.35 !important;
    max-width: 280px;
    word-wrap: break-word;
}
:global(.leaflet-tooltip.damage-marker-tip.leaflet-tooltip-top::before) {
    border-top-color: #fff !important;
}

.page-title {
    margin: 0 0 10px 0;
    padding: 10px 14px;
    font-family: var(--uk-font);
    font-size: 1.35rem;
    font-weight: bold;
    color: #000;
    background: #fff;
    border-radius: 8px;
    box-sizing: border-box;
    text-align: center;
}
.page-intro {
    margin: 0;
    font-family: var(--uk-font);
    font-size: 0.9rem;
    color: var(--uk-text-muted);
    line-height: 1.4;
    text-align: center;
}
.btn {
    background: var(--uk-yellow);
    color: #000;
    border: none;
    padding: 8px 12px;
    margin: 4px;
    cursor: pointer;
    border-radius: 6px;
    font-weight: bold;
}
.btn:hover {
    background: var(--uk-yellow-hover);
}
.container {
    padding: 20px;
    width: 100%;
    max-width: 1200px;
    margin: 0 auto;
    box-sizing: border-box;
}
input, textarea {
    display: block;
    margin: 10px 0;
    padding: 8px;
    width: 100%;
    max-width: 500px;
}
table {
    width: 100%;
    border-collapse: collapse;
    margin-top: 20px;
}
th, td {
    border: 1px solid var(--uk-border-table);
    padding: 8px;
    text-align: left;
}
th {
    background: var(--uk-blue-header);
    color: var(--uk-text);
}
.card {
    background: var(--uk-blue-card);
    padding: 20px;
    border-radius: 10px;
    width: 100%;
    max-width: 800px;
    margin: 20px auto;
    box-sizing: border-box;
}
.bulk-import-card .bulk-import-intro {
    margin: 0 0 16px 0;
    line-height: 1.45;
    color: var(--uk-text);
    font-size: 0.95rem;
}
.bulk-input-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
}
.bulk-import-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    margin: 0 0 12px 0;
}
.bulk-status,
.bulk-pending-count {
    margin: 8px 0;
    font-size: 0.9rem;
    color: var(--uk-text-muted);
    line-height: 1.4;
}
.bulk-pending-count {
    color: var(--uk-yellow);
    font-weight: 600;
}
.bulk-upload-submit {
    margin-top: 12px;
}
.add-image-file-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 14px;
    margin: 6px 0;
}
.add-image-file-btn {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    margin: 0;
    width: auto;
    max-width: none;
    padding: 4px 10px;
    box-sizing: border-box;
    font-size: 0.75rem;
    font-weight: 600;
    line-height: 1.25;
    border-radius: 4px;
}
.add-image-file-input {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
}
.add-image-view-link {
    color: var(--uk-yellow);
    text-decoration: underline;
    font-size: 0.78rem;
    font-weight: 400;
    line-height: 1.3;
}
.add-image-view-link:hover {
    color: var(--uk-yellow-hover);
}
.map-placeholder {
    height: 300px;
    background: var(--uk-blue-map-inner);
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 10px;
    width: 100%;
    box-sizing: border-box;
    border: 2px dashed var(--uk-yellow);
    cursor: crosshair;
    margin: 10px 0;
    color: var(--uk-text);
    font-style: italic;
}
.thumb-cell {
    width: 100px;
    vertical-align: middle;
}
.thumb {
    display: block;
    width: 88px;
    height: 66px;
    object-fit: cover;
    border-radius: 6px;
    border: 1px solid var(--uk-border-table);
}
.no-thumb {
    color: var(--uk-text-muted);
    font-size: 12px;
    font-style: italic;
}
</style>

<!-- LOGIN PAGE -->
{#if page === 'login'}
<div class="main-content">
  <h2 class="page-title">Ukraine Damage Mapping Login</h2>
  <div class="container">
    <div class="card">
      <input placeholder="Email" bind:value={email} /> <!-- ✅ updated to Email -->
      <input placeholder="Password" type="password" bind:value={password} />
      <button class="btn" on:click={handleLogin}>Login</button>
    </div>
  </div>
</div>
{/if}

<!-- MAIN DASHBOARD PAGE -->
{#if page === 'main'}
<div class="header">
  <div>
    <button class="btn" on:click={openNewPhotoForm}>Add Photo</button>
    <button class="btn" on:click={() => navigate('bulk')}>Bulk Import</button>
    <button class="btn" on:click={() => navigate('map')}>Show Map</button>
  </div>
  <button class="btn" on:click={() => navigate('login')}>Logout</button>
</div>

<div class="main-content">
  <div class="container">
    <br>
    <h2 class="page-title">Collected Images for {$user.email}</h2>
    <table>
      <thead>
        <tr>
          <th>Image</th><th>Title</th><th>Description</th><th>Locations</th><th>Azimuth</th><th>Edit</th><th>Delete</th>
        </tr>
      </thead>
      <tbody>
        {#each $photos as photo}
        <tr>
          <td class="thumb-cell">
            {#if photo.file_url}
              <img class="thumb" src={photo.file_url} alt="" loading="lazy" />
            {:else}
              <span class="no-thumb">No image</span>
            {/if}
          </td>
          <td>{photo.title}</td>
          <td>{photo.description}</td>
          <td>{photo.latitude}, {photo.longitude}</td>
          <td>{photo.azimuth}</td>
          <td><button class="btn" on:click={() => startEdit(photo)}>Edit</button></td>
          <td><button class="btn" on:click={() => deletePhoto(photo.image_id)}>Delete</button></td>
        </tr>
        {/each}
      </tbody>
    </table>
  </div>
</div>
{/if}

<!-- ADD / EDIT PHOTO PAGE -->
{#if page === 'add'}
<div class="header">
  <button class="btn" on:click={() => navigate('main')}>Back</button>
  <button class="btn" on:click={() => navigate('login')}>Logout</button>
</div>

<div class="main-content">
  <br>
  <h2 class="page-title">Add / Edit Photo</h2>
  <div class="container">
    <div class="card">
      <input placeholder="Title" bind:value={title} />
      <textarea placeholder="Description" bind:value={description}></textarea>
      <input placeholder="Latitude" bind:value={latitude} />
      <input placeholder="Longitude" bind:value={longitude} />
      <input placeholder="Azimuth" bind:value={azimuth} />
      {#if addAzimuthPickWaiting}
        <p class="add-azimuth-hint">
          Click the map in the direction the camera was facing (from the pin). Press Esc to cancel.
        </p>
      {/if}
      <div class="add-image-file-row">
        <label class="btn add-image-file-btn">
          {#if existingImageUrl}
            Change Image
          {:else}
            Choose image
          {/if}
          <input
            type="file"
            accept="image/*"
            class="add-image-file-input"
            on:change={onAddPhotoFileChange}
          />
        </label>
        {#if existingImageUrl}
          <a
            class="add-image-view-link"
            href={existingImageUrl}
            target="_blank"
            rel="noopener noreferrer"
          >click to view current image</a>
        {/if}
      </div>
      <div bind:this={addMapEl} class="map-placeholder"></div>
      <p>
        Click the map to set location, or leave coordinates blank to use GPS from the photo file when available.
        Double-click the pin to set azimuth, then click the map toward the subject.
      </p>
      <button class="btn" on:click={submitPhoto}>Submit</button>
    </div>
  </div>
</div>
{/if}

<!-- BULK UPLOAD PAGE -->
{#if page === 'bulk'}
<div class="header">
  <button class="btn" on:click={() => navigate('main')}>Back</button>
  <button class="btn" on:click={() => navigate('login')}>Logout</button>
</div>

<div class="main-content">
  <br>
  <h2 class="page-title">Bulk import</h2>
  <div class="container">
    <div class="card bulk-import-card">
      <p class="bulk-import-intro">
        Choose a <strong>folder</strong> of images or a <strong>.zip</strong> archive. Loose files are not accepted
        here — only folder or ZIP selection. Only image files (JPEG, PNG, GIF, WebP, BMP, TIFF, HEIC/HEIF) are sent to
        the database; other files are ignored.
      </p>
      <input
        bind:this={bulkFolderInput}
        type="file"
        class="bulk-input-hidden"
        webkitdirectory
        directory
        multiple
        on:change={onBulkFolderChange}
      />
      <input
        bind:this={bulkZipInput}
        type="file"
        class="bulk-input-hidden"
        accept=".zip,application/zip,application/x-zip-compressed"
        on:change={onBulkZipChange}
      />
      <div class="bulk-import-actions">
        <button
          type="button"
          class="btn"
          disabled={bulkUploading}
          on:click={() => bulkFolderInput?.click()}
        >
          Choose folder
        </button>
        <button
          type="button"
          class="btn"
          disabled={bulkUploading}
          on:click={() => bulkZipInput?.click()}
        >
          Choose ZIP
        </button>
      </div>
      {#if bulkStatusText}
        <p class="bulk-status">{bulkStatusText}</p>
      {/if}
      {#if bulkPendingFiles.length > 0}
        <p class="bulk-pending-count">{bulkPendingFiles.length} image(s) queued</p>
      {/if}
      <button
        type="button"
        class="btn bulk-upload-submit"
        disabled={bulkUploading || bulkPendingFiles.length === 0}
        on:click={runBulkUpload}
      >
        {#if bulkUploading}
          Uploading… {bulkUploadProgress}
        {:else}
          Upload to database
        {/if}
      </button>
    </div>
  </div>
</div>
{/if}

<!-- MAP PAGE -->
{#if page === 'map'}
<div class="header">
  <button type="button" class="btn" on:click={() => navigate('main')}>Back</button>
  <button type="button" class="btn" on:click={() => navigate('login')}>Logout</button>
</div>

<div class="main-content main-content--map">
  <div class="map-layout">
    <aside
      class="map-side-pane"
      class:map-side-pane--has-selection={hasDamageSidePaneContent}
      aria-label="Details for selected map point"
    >
      {#if mapPanePhoto}
        <div class="map-side-pane-header">
          <button
            type="button"
            class="map-side-close"
            on:click={clearMapSelection}
            aria-label="Close details panel"
            title="Close"
          >
            <span class="map-side-close-icon" aria-hidden="true">×</span>
          </button>
        </div>
        {#if damageMapSelection?.type === 'building'}
          <h3 class="map-building-pane-title">{damageBuildingTitle}</h3>
          {#if damageCarouselGroup && damageCarouselGroup.photos.length > 1}
            <div class="map-photo-carousel">
              <button
                type="button"
                class="map-carousel-btn"
                on:click={prevDamageBuildingPhoto}
                aria-label="Previous image"
              >‹</button>
              <span class="map-carousel-count"
                >Image {damageMapSelection.idx + 1} of {damageCarouselGroup.photos.length}</span
              >
              <button
                type="button"
                class="map-carousel-btn"
                on:click={nextDamageBuildingPhoto}
                aria-label="Next image"
              >›</button>
            </div>
          {/if}
        {:else if damageMapSelection?.type === 'orphan'}
          <p class="map-side-no-address-banner">No address associated with this image.</p>
        {/if}
        <div class="map-side-pane-toolbar">
          <button type="button" class="btn map-side-edit-btn" on:click={() => startEdit(mapPanePhoto)}
            >Edit image</button
          >
          {#if damageMapSelection?.type === 'building'}
            <button
              type="button"
              class="btn map-side-view-mode-btn"
              class:map-side-view-mode-btn--active={damageMapBuildingViewMode === 'point'}
              on:click={() => {
                damageMapBuildingViewMode =
                  damageMapBuildingViewMode === 'footprint' ? 'point' : 'footprint';
                tick().then(() => refreshDamageMapOverlays());
              }}
            >
              {damageMapBuildingViewMode === 'footprint' ? 'Show Point' : 'Show Footprint'}
            </button>
          {/if}
        </div>
        <div class="map-side-field map-side-field--image">
          <span class="map-side-label">Image</span>
          {#if mapPanePhoto.file_url}
            <div class="map-side-img-bleed">
              <img
                class="map-side-img"
                src={mapPanePhoto.file_url}
                alt={mapPanePhoto.title || 'Damage photo'}
                loading="lazy"
              />
            </div>
          {:else}
            <span class="map-side-placeholder">No image file for this record.</span>
          {/if}
        </div>
        <div class="map-side-field">
          <span class="map-side-label">Image ID</span>
          {mapPanePhoto.image_id != null ? mapPanePhoto.image_id : '—'}
        </div>
        <div class="map-side-field">
          <span class="map-side-label">User ID</span>
          {mapPanePhoto.user != null ? mapPanePhoto.user : '—'}
        </div>
        <div class="map-side-field">
          <span class="map-side-label">Title</span>
          {displayVal(mapPanePhoto.title)}
        </div>
        <div class="map-side-field">
          <span class="map-side-label">Description</span>
          {displayVal(mapPanePhoto.description)}
        </div>
        <div class="map-side-field">
          <span class="map-side-label">Latitude</span>
          {mapPanePhoto.latitude != null && !Number.isNaN(Number(mapPanePhoto.latitude))
            ? Number(mapPanePhoto.latitude).toFixed(6)
            : '—'}
        </div>
        <div class="map-side-field">
          <span class="map-side-label">Longitude</span>
          {mapPanePhoto.longitude != null && !Number.isNaN(Number(mapPanePhoto.longitude))
            ? Number(mapPanePhoto.longitude).toFixed(6)
            : '—'}
        </div>
        {#if damageMapSelection?.type !== 'building'}
          <div class="map-side-field">
            <span class="map-side-label">Address</span>
            {displayVal(mapPanePhoto.address)}
          </div>
        {/if}
        {#if damageMapSelection?.type !== 'building' || damageMapBuildingViewMode === 'point'}
          <div class="map-side-field">
            <span class="map-side-label">Azimuth</span>
            {#if hasAzimuth(mapPanePhoto)}
              {Number(mapPanePhoto.azimuth).toFixed(1)}°
            {:else}
              —
            {/if}
          </div>
        {/if}
        <div class="map-side-field">
          <span class="map-side-label">Upload date</span>
          {fmtDate(mapPanePhoto.upload_date)}
        </div>
        <div class="map-side-field">
          <span class="map-side-label">Picture date</span>
          {fmtDate(mapPanePhoto.picture_date)}
        </div>
        <div class="map-side-field">
          <span class="map-side-label">Metadata</span>
          <pre class="map-side-meta">{fmtMeta(mapPanePhoto.metadata)}</pre>
        </div>
        <div class="map-side-field">
          <span class="map-side-label">Image URL</span>
          {#if mapPanePhoto.file_url}
            <a class="map-side-link" href={mapPanePhoto.file_url} target="_blank" rel="noopener noreferrer"
              >Open image</a
            >
          {:else}
            —
          {/if}
        </div>
      {:else}
        <p class="map-side-placeholder">
          Click a point on the map to see every field for that record. Click the same point again to clear.
          Photos linked to a building (by GPS inside the outline or by azimuth ray) show as one footprint; others
          show as a point. OSM data loads within about {OSM_FETCH_BUFFER_M} m of each photo; ray match ≤
          {OSM_RAY_THRESHOLD_M} m along bearing (max {OSM_RAY_MAX_M} m).
        </p>
        {#if damageMapBuildingsSorted.length > 0}
          <h4 class="map-building-list-heading">Buildings</h4>
          <ul class="map-building-list" aria-label="Buildings on this map">
            {#each damageMapBuildingsSorted as g (g.osmId)}
              <li class="map-building-list-item">
                <button
                  type="button"
                  class="map-building-list-btn"
                  on:click={() => zoomDamageMapToBuilding(g.osmId)}
                >
                  <span class="map-building-list-title"
                    >{(g.addressLabel || '').trim() || 'Building (no address)'}</span
                  >
                  <span class="map-building-list-meta"
                    >{g.photos.length} image{g.photos.length === 1 ? '' : 's'}</span
                  >
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      {/if}
    </aside>
    <div class="map-main-column">
      <div class="map-head">
        <h2 class="page-title">Damage map</h2>
        <p class="page-intro">
          {#if mapPointCount === 0}
            No locations with coordinates yet — add photos with GPS or pick a point on the map when editing.
          {:else}
            {mapPointCount} location{mapPointCount === 1 ? '' : 's'} with coordinates
          {/if}
        </p>
        {#if damageMapOsmLoading}
          <p class="map-osm-status map-osm-status--loading">Loading building data from OpenStreetMap…</p>
        {:else if damageMapOsmError}
          <p class="map-osm-status map-osm-status--error">{damageMapOsmError}</p>
        {/if}
      </div>
      <div bind:this={mapEl} class="map-embed" role="application" aria-label="Interactive map of damage locations"></div>
    </div>
  </div>
</div>
{/if}