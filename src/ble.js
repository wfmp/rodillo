/* Bluetooth devices: FTMS smart trainer (with Cycling Power fallback), heart rate sensor, and a simulator. */
(function (root) {
  "use strict";

  const full = (short) => "0000" + short.toString(16).padStart(4, "0") + "-0000-1000-8000-00805f9b34fb";
  const UUID = {
    ftms: full(0x1826), indoorBikeData: full(0x2ad2), ftmsControlPoint: full(0x2ad9), ftmsStatus: full(0x2ada),
    cyclingPower: full(0x1818), cyclingPowerMeasurement: full(0x2a63),
    heartRate: full(0x180d), heartRateMeasurement: full(0x2a37),
  };

  // Diagnostic log shown in the app settings
  const bleLog = [];
  function log(msg) {
    const line = new Date().toLocaleTimeString() + "  " + msg;
    bleLog.push(line);
    if (bleLog.length > 200) bleLog.shift();
    if (typeof console !== "undefined") console.log("[ble] " + msg);
  }
  function errorText(e) {
    if (e == null) return "error sin detalle";
    if (typeof e === "string") return e;
    const parts = [e.name, e.message, e.code != null ? "code " + e.code : null].filter(Boolean);
    return parts.length ? parts.join(": ") : String(e);
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  /** Run an async step, logging it; retries help with flaky iOS Bluetooth stacks. */
  async function step(label, fn, retries) {
    retries = retries || 0;
    for (let attempt = 0; ; attempt++) {
      try {
        log(label + (attempt ? " (reintento " + attempt + ")" : ""));
        const result = await fn();
        log(label + " ✓");
        return result;
      } catch (e) {
        log(label + " ✗ " + errorText(e));
        if (attempt >= retries) {
          const err = new Error(label + ": " + errorText(e));
          err.name = e && e.name;
          throw err;
        }
        await sleep(600);
      }
    }
  }

  const FTMS_OP = { requestControl: 0x00, reset: 0x01, setTargetPower: 0x05, startResume: 0x07, stopPause: 0x08 };

  /** Parse the FTMS Indoor Bike Data characteristic. */
  function parseIndoorBikeData(dv) {
    const flags = dv.getUint16(0, true);
    let o = 2;
    const out = {};
    if (!(flags & 0x0001)) { out.speedKmh = dv.getUint16(o, true) / 100; o += 2; } // "more data" bit inverted
    if (flags & 0x0002) o += 2; // average speed
    if (flags & 0x0004) { out.cadence = dv.getUint16(o, true) / 2; o += 2; }
    if (flags & 0x0008) o += 2; // average cadence
    if (flags & 0x0010) o += 3; // total distance
    if (flags & 0x0020) o += 2; // resistance level
    if (flags & 0x0040) { out.power = dv.getInt16(o, true); o += 2; }
    if (flags & 0x0080) o += 2; // average power
    if (flags & 0x0100) o += 5; // expended energy
    if (flags & 0x0200) { out.hr = dv.getUint8(o); o += 1; }
    return out;
  }

  /** Parse the Cycling Power Measurement characteristic (power plus crank cadence when present). */
  function makeCyclingPowerParser() {
    let lastCrank = null;
    return function parse(dv) {
      const flags = dv.getUint16(0, true);
      const out = { power: dv.getInt16(2, true) };
      let o = 4;
      if (flags & 0x0001) o += 1; // pedal power balance
      if (flags & 0x0004) o += 2; // accumulated torque
      if (flags & 0x0010) o += 6; // wheel revolutions
      if (flags & 0x0020) {
        const revs = dv.getUint16(o, true);
        const time = dv.getUint16(o + 2, true); // 1/1024 s
        if (lastCrank) {
          const dRev = (revs - lastCrank.revs + 0x10000) & 0xffff;
          const dTime = ((time - lastCrank.time + 0x10000) & 0xffff) / 1024;
          if (dTime > 0 && dRev < 10) out.cadence = Math.round(dRev / dTime * 60);
          else if (dTime === 0) out.cadence = lastCrank.cadence;
        }
        lastCrank = { revs, time, cadence: out.cadence };
      }
      return out;
    };
  }

  function parseHeartRate(dv) {
    const flags = dv.getUint8(0);
    return { hr: (flags & 0x01) ? dv.getUint16(1, true) : dv.getUint8(1) };
  }

  class Emitter {
    constructor() { this.handlers = {}; }
    on(evt, fn) { (this.handlers[evt] = this.handlers[evt] || []).push(fn); }
    emit(evt, data) { (this.handlers[evt] || []).forEach((fn) => fn(data)); }
  }

  function bluetoothAvailable() {
    return typeof navigator !== "undefined" && !!navigator.bluetooth;
  }

  class Trainer extends Emitter {
    constructor() {
      super();
      this.device = null; this.controlPoint = null; this.canControl = false;
      this.queue = Promise.resolve(); this.lastTarget = null; this.name = "";
    }
    async connect() {
      const device = await step("Elegir rodillo", () => navigator.bluetooth.requestDevice({
        filters: [{ services: [UUID.ftms] }, { services: [UUID.cyclingPower] }, { namePrefix: "SUITO" }, { namePrefix: "Suito" }],
        optionalServices: [UUID.ftms, UUID.cyclingPower],
      }));
      this.device = device;
      this.name = device.name || "Rodillo";
      log("Dispositivo: " + this.name);
      device.addEventListener("gattserverdisconnected", () => this.handleDisconnect());
      await this.setup();
    }
    async setup() {
      const server = await step("Conectar GATT", () => this.device.gatt.connect(), 2);
      await sleep(300);
      try {
        const services = await server.getPrimaryServices();
        log("Servicios: " + services.map((x) => x.uuid.slice(4, 8)).join(", "));
      } catch (e) { log("No se pudo listar servicios: " + errorText(e)); }
      let ftms = null;
      try { ftms = await step("Servicio FTMS", () => server.getPrimaryService(UUID.ftms), 2); } catch (e) { ftms = null; }
      if (ftms) {
        const data = await step("Característica Indoor Bike Data", () => ftms.getCharacteristic(UUID.indoorBikeData), 1);
        data.addEventListener("characteristicvaluechanged", (e) => this.emit("data", parseIndoorBikeData(e.target.value)));
        await step("Activar datos del rodillo", () => data.startNotifications(), 2);
        try {
          this.controlPoint = await step("Característica Control Point", () => ftms.getCharacteristic(UUID.ftmsControlPoint), 1);
          this.controlPoint.addEventListener("characteristicvaluechanged", (e) => this.handleControlResponse(e.target.value));
          await step("Activar respuestas de control", () => this.controlPoint.startNotifications(), 2);
          await step("Pedir control", () => this.sendControl([FTMS_OP.requestControl]), 1);
          await step("Iniciar", () => this.sendControl([FTMS_OP.startResume]), 1);
          this.canControl = true;
        } catch (e) {
          this.canControl = false;
          this.emit("warning", "El rodillo no aceptó el control (" + e.message + "). Solo se leerán datos.");
        }
        this.mode = "ftms";
      } else {
        const cps = await step("Servicio Cycling Power", () => server.getPrimaryService(UUID.cyclingPower), 1);
        const meas = await step("Característica de potencia", () => cps.getCharacteristic(UUID.cyclingPowerMeasurement), 1);
        const parse = makeCyclingPowerParser();
        meas.addEventListener("characteristicvaluechanged", (e) => this.emit("data", parse(e.target.value)));
        await step("Activar potencia", () => meas.startNotifications(), 2);
        this.canControl = false;
        this.mode = "power";
        this.emit("warning", "Este dispositivo solo envía potencia: no se puede controlar la resistencia.");
      }
      this.lastTarget = null;
      this.emit("connected", { name: this.name, canControl: this.canControl });
    }
    handleControlResponse(dv) {
      if (dv.getUint8(0) === 0x80 && dv.byteLength >= 3) {
        const op = dv.getUint8(1), result = dv.getUint8(2);
        log("Respuesta control: orden " + op + " resultado " + result);
        if (result !== 0x01) this.emit("warning", `El rodillo rechazó la orden ${op} (código ${result}).`);
      }
    }
    sendControl(bytes) {
      const task = this.queue.then(() => this.controlPoint.writeValueWithResponse
        ? this.controlPoint.writeValueWithResponse(new Uint8Array(bytes))
        : this.controlPoint.writeValue(new Uint8Array(bytes)));
      this.queue = task.catch(() => {});
      return task;
    }
    setTargetPower(watts) {
      if (!this.canControl || !this.controlPoint) return;
      const w = Math.max(0, Math.min(2000, Math.round(watts)));
      if (w === this.lastTarget) return;
      this.lastTarget = w;
      this.sendControl([FTMS_OP.setTargetPower, w & 0xff, (w >> 8) & 0xff]).catch((e) => {
        log("Objetivo " + w + " W ✗ " + errorText(e));
        this.emit("warning", "No se pudo enviar la potencia objetivo: " + errorText(e));
      });
    }
    async handleDisconnect() {
      this.canControl = false; this.controlPoint = null;
      this.emit("disconnected");
      // Try to reconnect a few times; the trainer may drop the link briefly
      for (let attempt = 1; attempt <= 5 && this.device; attempt++) {
        await new Promise((r) => setTimeout(r, 2000 * attempt));
        try { await this.setup(); return; } catch (e) { /* retry */ }
      }
    }
    disconnect() {
      const d = this.device; this.device = null;
      if (d && d.gatt.connected) d.gatt.disconnect();
    }
  }

  class HeartRateSensor extends Emitter {
    constructor() { super(); this.device = null; this.name = ""; }
    async connect() {
      const device = await step("Elegir pulsómetro", () => navigator.bluetooth.requestDevice({ filters: [{ services: [UUID.heartRate] }] }));
      this.device = device;
      this.name = device.name || "Pulso";
      device.addEventListener("gattserverdisconnected", () => this.handleDisconnect());
      await this.setup();
    }
    async setup() {
      const server = await step("Pulso: conectar GATT", () => this.device.gatt.connect(), 2);
      await sleep(300);
      const svc = await step("Pulso: servicio", () => server.getPrimaryService(UUID.heartRate), 2);
      const ch = await step("Pulso: característica", () => svc.getCharacteristic(UUID.heartRateMeasurement), 1);
      ch.addEventListener("characteristicvaluechanged", (e) => this.emit("data", parseHeartRate(e.target.value)));
      await step("Pulso: activar", () => ch.startNotifications(), 2);
      this.emit("connected", { name: this.name });
    }
    async handleDisconnect() {
      this.emit("disconnected");
      for (let attempt = 1; attempt <= 5 && this.device; attempt++) {
        await new Promise((r) => setTimeout(r, 2000 * attempt));
        try { await this.setup(); return; } catch (e) { /* retry */ }
      }
    }
    disconnect() {
      const d = this.device; this.device = null;
      if (d && d.gatt.connected) d.gatt.disconnect();
    }
  }

  /** Simulated trainer + heart rate for trying the app without hardware. */
  class SimulatedRig extends Emitter {
    constructor(ftp) {
      super();
      this.name = "Simulador"; this.canControl = true; this.target = 100; this.hr = 72; this.ftp = ftp || 165;
      this.timer = null; this.power = 0;
    }
    async connect() {
      this.timer = setInterval(() => this.tick(), 1000);
      this.emit("connected", { name: this.name, canControl: true });
    }
    tick() {
      this.power += (this.target - this.power) * 0.5;
      const power = Math.max(0, Math.round(this.power + (Math.random() - 0.5) * 12));
      const effort = power / this.ftp;
      this.hr += ((85 + effort * 75) - this.hr) / 25;
      this.emit("data", { power, cadence: Math.round(86 + Math.random() * 6), speedKmh: 18 + power / 12, hr: Math.round(this.hr) });
    }
    setTargetPower(w) { this.target = w; }
    disconnect() { clearInterval(this.timer); this.timer = null; this.emit("disconnected"); }
  }

  root.RodilloBle = { Trainer, HeartRateSensor, SimulatedRig, bluetoothAvailable, parseIndoorBikeData, bleLog, errorText };
})(typeof window !== "undefined" ? window : globalThis);
