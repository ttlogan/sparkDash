const MAX_POWER_TELEMETRY_AGE_MS = 10_000;
const ENERGY_SAMPLE_INTERVAL_MS = 2_000;

function hasFreshTimestamp(timestamp, atMs) {
  if (!Number.isFinite(timestamp) || !Number.isFinite(atMs)) return false;
  const ageMs = atMs - timestamp;
  return ageMs >= 0 && ageMs <= MAX_POWER_TELEMETRY_AGE_MS;
}

function isDefaultGpuResult(gpu) {
  return (
    gpu?.temperature === 0 &&
    gpu?.usage === 0 &&
    gpu?.power?.draw === 0 &&
    gpu?.vram?.total === 0
  );
}

function isDefaultCpuResult(cpu) {
  return (
    cpu?.usage === 0 &&
    cpu?.temperature === 0 &&
    cpu?.draw === 0 &&
    cpu?.tdp === 0
  );
}

function wasCollectionSuccessful(monitor, domain) {
  return monitor?._metricCollectionSuccessful?.[domain] === true;
}

/** Determine whether a normal SparkMonitor snapshot has current usable power telemetry. */
export function hasFreshPowerTelemetry(snapshot, monitor, atMs) {
  const gpu = snapshot?.metrics?.gpu;
  const cpu = snapshot?.metrics?.cpu;
  return (
    snapshot?.online === true &&
    wasCollectionSuccessful(monitor, "gpu") &&
    wasCollectionSuccessful(monitor, "cpu") &&
    hasFreshTimestamp(monitor?._lastUpdate?.gpu, atMs) &&
    hasFreshTimestamp(monitor?._lastUpdate?.cpu, atMs) &&
    !isDefaultGpuResult(gpu) &&
    !isDefaultCpuResult(cpu) &&
    Number.isFinite(gpu?.power?.draw) &&
    Number.isFinite(cpu?.usage)
  );
}

/**
 * Record one independent energy sample. Only the shallow clones passed to the
 * tracker receive telemetryFresh; normal REST and WebSocket snapshots remain unchanged.
 */
export function runFleetEnergySamplerTick({
  tracker,
  orderedSnapshots,
  monitors,
  now = Date.now,
}) {
  const atMs = now();
  const snapshots = orderedSnapshots();
  const trackerInputs = snapshots.map((snapshot) => ({
    ...snapshot,
    telemetryFresh: hasFreshPowerTelemetry(
      snapshot,
      monitors?.get?.(snapshot?.id),
      atMs
    ),
  }));
  return tracker.record(trackerInputs, atMs);
}

/** Default electricity price per kWh (EUR) — Naples, Italy retail average.
 *  Override with ELECTRICITY_PRICE_PER_KWH in the service env. */
const DEFAULT_ELECTRICITY_PRICE_PER_KWH = 0.30;

function electricityPricePerKwh() {
  const value = Number(process.env.ELECTRICITY_PRICE_PER_KWH);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_ELECTRICITY_PRICE_PER_KWH;
}

/** Build the read-only Express handler around the tracker's canonical contract. */
export function createFleetEnergyHandler(tracker) {
  return (_req, res) => {
    const snapshot = tracker.snapshot();
    const pricePerKwh = electricityPricePerKwh();
    return res.json({
      ...snapshot,
      electricityPricePerKwh: pricePerKwh,
      cost24hEuros:
        snapshot.energy24hKwh == null ? null : snapshot.energy24hKwh * pricePerKwh,
      cost31dEuros:
        snapshot.energy31dKwh == null ? null : snapshot.energy31dKwh * pricePerKwh,
      costTodayEuros:
        snapshot.energyTodayKwh == null ? null : snapshot.energyTodayKwh * pricePerKwh,
      costThisMonthEuros:
        snapshot.energyThisMonthKwh == null ? null : snapshot.energyThisMonthKwh * pricePerKwh,
      costLastMonthEuros:
        snapshot.energyLastMonthKwh == null ? null : snapshot.energyLastMonthKwh * pricePerKwh,
      costTotalEuros:
        snapshot.energyTotalKwh == null ? null : snapshot.energyTotalKwh * pricePerKwh,
    });
  };
}

/** Register the read-only fleet-energy endpoint. */
export function registerFleetEnergyRoute(app, tracker) {
  return app.get("/api/fleet-energy", createFleetEnergyHandler(tracker));
}

/** Preserve startup ordering without coupling the sampler to server or WS state. */
export function startFleetEnergyCollection({ startAllMonitors, energyRuntime }) {
  startAllMonitors();
  return energyRuntime.start();
}

/** Build the graceful server-close callback from the persistence outcome. */
export function createFleetEnergyExitHandler(
  energyPersistenceSucceeded,
  exit = process.exit
) {
  return () => exit(energyPersistenceSucceeded ? 0 : 1);
}

/** Own the independent sampling timer and the tracker's one-time close lifecycle. */
export function createFleetEnergyRuntime({
  tracker,
  orderedSnapshots,
  monitors,
  now = Date.now,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  logError = console.error,
}) {
  let started = false;
  let stopped = false;
  let timer = null;
  let stopResult = false;

  const reportError = (message, error) => {
    try {
      logError(message, error);
    } catch {
      // Logging must never prevent shutdown from continuing.
    }
  };

  const sample = () => {
    if (stopped) return;
    try {
      runFleetEnergySamplerTick({ tracker, orderedSnapshots, monitors, now });
    } catch (error) {
      reportError("fleet energy sample error", error);
    }
  };

  return {
    start() {
      if (started || stopped) return false;
      started = true;
      sample();
      timer = setIntervalFn(sample, ENERGY_SAMPLE_INTERVAL_MS);
      return true;
    },

    stop() {
      if (stopped) return stopResult;
      stopped = true;
      if (timer !== null) {
        try {
          clearIntervalFn(timer);
        } catch (error) {
          reportError("fleet energy timer shutdown error", error);
        }
        timer = null;
      }
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          tracker.close();
          stopResult = true;
          break;
        } catch (error) {
          reportError(`fleet energy shutdown error (attempt ${attempt}/2)`, error);
        }
      }
      return stopResult;
    },
  };
}
