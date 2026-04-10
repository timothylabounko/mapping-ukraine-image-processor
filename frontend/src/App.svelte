<svelte:head>
  <title>MU Image Collector</title>
</svelte:head>

<script>
import { writable, get } from 'svelte/store';
import { user, photos, editId } from './stores.js'; // ✅ added editId
import axios from 'axios';
import { onMount, tick } from 'svelte';
import * as L from 'leaflet';
import 'leaflet/dist/leaflet.css';

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

function navigate(p) {
    page = p;
    clearMapSelection();
    hoverArrowGroup = null;
    photoMarkersGroup = null;

    // cleanup dashboard map
    if (p !== 'map' && map) {
        map.remove();
        map = null;
    }

    // cleanup add map
    if (p !== 'add' && addMap) {
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
        alert('Login failed: ' + (err.response?.data?.error || err.message));
    }
}

// Fetch photos for logged-in user
async function fetchPhotos() {
    const $user = get(user);
    if (!$user) return;
    const res = await axios.get(`http://localhost:8000/api/images/?user_id=${$user.user_id}`);
    photos.set(res.data);
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
        alert('Error submitting photo');
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
    navigate('add');
}

// Delete photo
async function deletePhoto(id) {
    if (!confirm('Delete this photo?')) return;
    await axios.delete(`http://localhost:8000/api/images/${id}/`);
    fetchPhotos();
}

// On mount, fetch photos if user already logged in
onMount(() => {
    if (get(user)) fetchPhotos();
});

let mapEl;        // dashboard map
let map;          // dashboard map instance
let photoMarkersGroup = null;
let hoverArrowGroup = null;
let selectedPhoto = null;

let addMapEl;     // add/edit page map
let addMap;       // add/edit map instance

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

function clearMapSelection() {
    selectedPhoto = null;
    clearHoverArrow();
}

function toggleMapMarkerSelection(p) {
    if (selectedPhoto != null && selectedPhoto.image_id === p.image_id) {
        clearMapSelection();
        return;
    }
    selectedPhoto = p;
    if (hasAzimuth(p)) {
        showHoverArrow(p);
    } else {
        clearHoverArrow();
    }
}

function markerHoverTitle(p) {
    const t = p.title != null && String(p.title).trim() !== '' ? String(p.title).trim() : '';
    return t || '(No title)';
}

/** Bearing in degrees (0 = north); same convention as existing lat/lng offset. */
function showHoverArrow(photo) {
    clearHoverArrow();
    if (!hasAzimuth(photo) || !map) return;
    const az = Number(photo.azimuth);
    const lat = Number(photo.latitude);
    const lng = Number(photo.longitude);
    const len = 0.012;
    const rad = (az * Math.PI) / 180;
    const endLat = lat + len * Math.cos(rad);
    const endLng = lng + len * Math.sin(rad);
    const line = L.polyline(
        [
            [lat, lng],
            [endLat, endLng]
        ],
        { color: '#ca8a04', weight: 4 }
    );
    const spread = 0.35;
    const hlen = len * 0.28;
    const tip = [endLat, endLng];
    const b1 = [
        endLat - hlen * Math.cos(rad - spread),
        endLng - hlen * Math.sin(rad - spread)
    ];
    const b2 = [
        endLat - hlen * Math.cos(rad + spread),
        endLng - hlen * Math.sin(rad + spread)
    ];
    const head = L.polygon([tip, b1, b2], {
        color: '#ca8a04',
        fillColor: '#ca8a04',
        fillOpacity: 1,
        weight: 2
    });
    hoverArrowGroup = L.layerGroup([line, head]).addTo(map);
}

$: mapPointCount = ($photos || []).filter(
    (p) => p.latitude != null && p.longitude != null
).length;

$: if (page === 'map' && mapEl && !map) {
    map = L.map(mapEl).setView([48.3794, 31.1656], 6);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(map);
    photoMarkersGroup = L.layerGroup().addTo(map);
    tick().then(() => {
        if (map) map.invalidateSize();
    });
}

$: if (page === 'map' && map && photoMarkersGroup) {
    photoMarkersGroup.clearLayers();
    clearMapSelection();

    ($photos || []).forEach((p) => {
        if (p.latitude == null || p.longitude == null) return;
        const plat = Number(p.latitude);
        const plng = Number(p.longitude);
        if (Number.isNaN(plat) || Number.isNaN(plng)) return;

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

    // ✅ Click to set lat/lng
    addMap.on('click', function(e) {
        latitude = e.latlng.lat.toFixed(6);
        longitude = e.latlng.lng.toFixed(6);

        // Optional: add marker
        addMap.eachLayer(layer => {
            if (layer instanceof L.Marker) addMap.removeLayer(layer);
        });

        L.marker([latitude, longitude]).addTo(addMap);
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
.map-side-img-bleed {
    margin-left: -12px;
    margin-right: -12px;
    width: calc(100% + 24px);
    max-width: calc(100% + 24px);
    box-sizing: border-box;
}
.map-side-img-wrap {
    position: relative;
}
.map-side-img-tip {
    position: absolute;
    left: 50%;
    bottom: calc(100% + 6px);
    transform: translateX(-50%);
    padding: 5px 9px;
    font-size: 0.75rem;
    line-height: 1.25;
    font-weight: bold;
    color: #0f172a;
    background: #fff;
    border: 1px solid var(--uk-border-table);
    border-radius: 6px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
    max-width: min(100%, 260px);
    text-align: center;
    word-break: break-word;
    opacity: 0;
    visibility: hidden;
    pointer-events: none;
    transition: opacity 0.12s ease, visibility 0.12s ease;
    z-index: 5;
}
.map-side-img-wrap:hover .map-side-img-tip {
    opacity: 1;
    visibility: visible;
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
    <button class="btn" on:click={() => navigate('add')}>Add Photo</button>
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
      <input type="file" on:change={e => file = e.target.files[0]} />
      <div bind:this={addMapEl} class="map-placeholder"></div>
      <p>Click on the map to set location</p>      
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
  <h2 class="page-title">Bulk Upload Photos</h2>
  <div class="container">
    <div class="card">
      <input type="file" webkitdirectory directory multiple />
      <button class="btn" on:click={() => navigate('main')}>Upload</button>
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
      class:map-side-pane--has-selection={!!selectedPhoto}
      aria-label="Details for selected map point"
    >
      {#if selectedPhoto}
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
        <div class="map-side-field map-side-field--image">
          <span class="map-side-label">Image</span>
          {#if selectedPhoto.file_url}
            <div class="map-side-img-bleed map-side-img-wrap">
              <img
                class="map-side-img"
                src={selectedPhoto.file_url}
                alt={selectedPhoto.title || 'Damage photo'}
                loading="lazy"
              />
              {#if selectedPhoto.title}
                <span class="map-side-img-tip">{selectedPhoto.title}</span>
              {/if}
            </div>
          {:else}
            <span class="map-side-placeholder">No image file for this record.</span>
          {/if}
        </div>
        <div class="map-side-field">
          <span class="map-side-label">Image ID</span>
          {selectedPhoto.image_id != null ? selectedPhoto.image_id : '—'}
        </div>
        <div class="map-side-field">
          <span class="map-side-label">User ID</span>
          {selectedPhoto.user != null ? selectedPhoto.user : '—'}
        </div>
        <div class="map-side-field">
          <span class="map-side-label">Title</span>
          {displayVal(selectedPhoto.title)}
        </div>
        <div class="map-side-field">
          <span class="map-side-label">Description</span>
          {displayVal(selectedPhoto.description)}
        </div>
        <div class="map-side-field">
          <span class="map-side-label">Latitude</span>
          {selectedPhoto.latitude != null && !Number.isNaN(Number(selectedPhoto.latitude))
            ? Number(selectedPhoto.latitude).toFixed(6)
            : '—'}
        </div>
        <div class="map-side-field">
          <span class="map-side-label">Longitude</span>
          {selectedPhoto.longitude != null && !Number.isNaN(Number(selectedPhoto.longitude))
            ? Number(selectedPhoto.longitude).toFixed(6)
            : '—'}
        </div>
        <div class="map-side-field">
          <span class="map-side-label">Address</span>
          {displayVal(selectedPhoto.address)}
        </div>
        <div class="map-side-field">
          <span class="map-side-label">Azimuth</span>
          {#if hasAzimuth(selectedPhoto)}
            {Number(selectedPhoto.azimuth).toFixed(1)}°
          {:else}
            —
          {/if}
        </div>
        <div class="map-side-field">
          <span class="map-side-label">Upload date</span>
          {fmtDate(selectedPhoto.upload_date)}
        </div>
        <div class="map-side-field">
          <span class="map-side-label">Picture date</span>
          {fmtDate(selectedPhoto.picture_date)}
        </div>
        <div class="map-side-field">
          <span class="map-side-label">Metadata</span>
          <pre class="map-side-meta">{fmtMeta(selectedPhoto.metadata)}</pre>
        </div>
        <div class="map-side-field">
          <span class="map-side-label">Image URL</span>
          {#if selectedPhoto.file_url}
            <a class="map-side-link" href={selectedPhoto.file_url} target="_blank" rel="noopener noreferrer"
              >Open image</a
            >
          {:else}
            —
          {/if}
        </div>
      {:else}
        <p class="map-side-placeholder">
          Click a point on the map to see every field for that record. Click the same point again to clear.
        </p>
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
      </div>
      <div bind:this={mapEl} class="map-embed" role="application" aria-label="Interactive map of damage locations"></div>
    </div>
  </div>
</div>
{/if}