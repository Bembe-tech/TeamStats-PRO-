// Map Creator: runs the OpenFront map generator off the main thread.
importScripts("/js/openfront-mapgen.js");
self.onmessage = e => {
  const { id, rgba, width, height } = e.data;
  try {
    const r = OFMapGen.generate(rgba, width, height, { progress: msg => self.postMessage({ id, progress: msg }) });
    self.postMessage({ id, result: r }, [r.map.data.buffer, r.map4x.data.buffer, r.map16x.data.buffer, r.thumb.data.buffer]);
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message || err) });
  }
};
