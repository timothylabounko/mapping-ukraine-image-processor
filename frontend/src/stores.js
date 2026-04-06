// src/stores.js
import { writable } from 'svelte/store';

export const user = writable(null);      // current logged-in user
export const photos = writable([]);      // user's images
export const editId = writable(null);    // currently edited photo ID