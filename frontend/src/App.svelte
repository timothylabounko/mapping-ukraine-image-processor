<svelte:head>
  <title>MU Image Collector</title>
</svelte:head>

<script>
import { writable, get } from 'svelte/store';
import { user, photos, editId } from './stores.js'; // ✅ added editId
import axios from 'axios';
import { onMount } from 'svelte';
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

// Navigate pages
function navigate(p) {
    page = p;
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
    formData.append('latitude', latitude);
    formData.append('longitude', longitude);
    formData.append('azimuth', azimuth);
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
    editId.set(photo.id);
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

// Map
let mapEl;
let map;

onMount(() => {
    map = L.map(mapEl).setView([48.3794, 31.1656], 6);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png").addTo(map);
});

// Update markers whenever photos change
$: if (map) {
    map.eachLayer(layer => {
        if (layer instanceof L.Marker || layer instanceof L.Polyline) {
            map.removeLayer(layer);
        }
    });

    get(photos)?.forEach(p => {
        if (p.latitude && p.longitude) {
            const marker = L.marker([p.latitude, p.longitude]).addTo(map);
            const next = [
                p.latitude + 0.01 * Math.cos(p.azimuth * Math.PI / 180),
                p.longitude + 0.01 * Math.sin(p.azimuth * Math.PI / 180)
            ];
            L.polyline([[p.latitude, p.longitude], next], { color: "red" }).addTo(map);
        }
    });
}
</script>

<style>
html, body {
    margin: 0;
    padding: 0;
    width: 100%;
    overflow-x: hidden;
    font-family: Arial, sans-serif;
    background: #0b1f3a;
    color: #f1f5f9;
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
    background: #1e3a8a;
    border-bottom: 3px solid #facc15;
    box-sizing: border-box;
    z-index: 1000;
}
.main-content {
    margin-top: 64px;
}
.btn {
    background: #facc15;
    color: #000;
    border: none;
    padding: 8px 12px;
    margin: 4px;
    cursor: pointer;
    border-radius: 6px;
    font-weight: bold;
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
    border: 1px solid #ccc;
    padding: 8px;
    text-align: left;
}
th {
    background: #1e3a8a;
    color: white;
}
.card {
    background: #132c4c;
    padding: 20px;
    border-radius: 10px;
    width: 100%;
    max-width: 800px;
    margin: 20px auto;
    box-sizing: border-box;
}
.map-placeholder {
    height: 300px;
    background: #0f172a;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 10px;
    width: 100%;
    box-sizing: border-box;
    border: 2px dashed #facc15;
    cursor: crosshair;
    margin: 10px 0;
    color: #f1f5f9;
    font-style: italic;
}
.dashboard-map-placeholder {
    height: 400px;
}
</style>

<!-- LOGIN PAGE -->
{#if page === 'login'}
<div class="main-content">
  <h2>Ukraine Damage Mapping Login</h2>
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
    <h2>Collected Images for {$user.email}</h2>
    <table>
      <thead>
        <tr>
          <th>ID</th><th>Title</th><th>Description</th><th>Locations</th><th>Azimuth</th><th>Edit</th><th>Delete</th>
        </tr>
      </thead>
      <tbody>
        {#each $photos as photo}
        <tr>
          <td>{photo.id}</td>
          <td>{photo.title}</td>
          <td>{photo.description}</td>
          <td>{photo.latitude}, {photo.longitude}</td>
          <td>{photo.azimuth}</td>
          <td><button class="btn" on:click={() => startEdit(photo)}>Edit</button></td>
          <td><button class="btn" on:click={() => deletePhoto(photo.id)}>Delete</button></td>
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
  <h2>Add / Edit Photo</h2>
  <div class="container">
    <div class="card">
      <input placeholder="Title" bind:value={title} />
      <textarea placeholder="Description" bind:value={description}></textarea>
      <input placeholder="Latitude" bind:value={latitude} />
      <input placeholder="Longitude" bind:value={longitude} />
      <input placeholder="Azimuth" bind:value={azimuth} />
      <input type="file" on:change={e => file = e.target.files[0]} />
      <div class="map-placeholder">Click on the map to set location</div>
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
  <h2>Bulk Upload Photos</h2>
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
  <button class="btn" on:click={() => navigate('main')}>Back</button>
  <button class="btn" on:click={() => navigate('login')}>Logout</button>
</div>

<div class="main-content">
  <br>
  <h2>Damage Map</h2>
  <div bind:this={mapEl} class="container dashboard-map-placeholder"></div>
</div>
{/if}