'use strict';
// Tiny JSON persistence for settings + activity history.
const fs = require('fs');
const path = require('path');

class JsonStore {
  constructor(file, defaults) {
    this.file = file;
    this.data = { ...defaults };
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      this.data = { ...defaults, ...raw };
    } catch {}
    this._t = null;
  }
  get(k) { return this.data[k]; }
  set(patch) { Object.assign(this.data, patch); this.save(); }
  save() {
    clearTimeout(this._t);
    this._t = setTimeout(() => this.flush(), 300);
  }
  flush() {
    clearTimeout(this._t);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error('store save failed', e);
    }
  }
}

module.exports = { JsonStore };
