<script>
  let page = 'login';

  function navigate(p) {
    page = p;
  }

  let photos = [
    { id:1, title:'Damaged building', description:'Roof collapse', location:'Kyiv', azimuth:'120°', uploadDate:'2026-04-05', pictureDate:'2026-04-01', metadata:'{}' },
    { id:2, title:'Destroyed bridge', description:'Bridge blown up', location:'Kharkiv', azimuth:'90°', uploadDate:'2026-04-04', pictureDate:'2026-04-02', metadata:'{}' },
  ];
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

  /* Full-width fixed header */
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
    margin-top: 64px; /* space for header */
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

  /* Map placeholder */
  .map-placeholder {
    height: 300px; /* smaller for Add/Edit page */
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
    height: 400px; /* bigger for dashboard map */
  }
</style>

<!-- LOGIN PAGE -->
{#if page === 'login'}
  <div class="main-content">
    <h2>Ukraine Damage Mapping Login</h2>
    <div class="container">
      <div class="card">
        <input placeholder="Username" />
        <input placeholder="Password" type="password" />
        <input placeholder="Phone Number" />
        <input placeholder="Email" />
        <button class="btn" on:click={() => navigate('main')}>Login</button>
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
      <h2>Collected Damage Images</h2>
      <table>
        <thead>
          <tr>
            <th>ID</th><th>Title</th><th>Description</th><th>Location</th><th>Azimuth</th><th>Upload Date</th><th>Picture Date</th><th>Metadata</th><th>Edit</th><th>Delete</th>
          </tr>
        </thead>
        <tbody>
          {#each photos as photo}
          <tr>
            <td>{photo.id}</td>
            <td>{photo.title}</td>
            <td>{photo.description}</td>
            <td>{photo.location}</td>
            <td>{photo.azimuth}</td>
            <td>{photo.uploadDate}</td>
            <td>{photo.pictureDate}</td>
            <td>{photo.metadata}</td>
            <td><button class="btn" on:click={() => navigate('add')}>Edit</button></td>
            <td><button class="btn">Delete</button></td>
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
        <input placeholder="Title" />
        <textarea placeholder="Description"></textarea>
        <input placeholder="Location" />
        <input placeholder="Azimuth" />
        <input type="file" />

        <!-- Map placeholder for manual location -->
        <div class="map-placeholder">
          Click on the map to set location
        </div>

        <button class="btn" on:click={() => navigate('main')}>Submit</button>
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
    <div class="container">
      <div class="map-placeholder dashboard-map-placeholder">
        Leaflet Map Placeholder
      </div>
    </div>
  </div>
{/if}