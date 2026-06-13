/**
 * Lightweight in-memory OTLP metrics exporter for Cloudflare Workers.
 *
 * Cloudflare does not yet export Worker metrics via OTLP natively (only traces
 * and logs). This module collects counters, gauges, and histograms in memory,
 * serializes them to OTLP/JSON, and POSTs them to any OTLP-compatible endpoint
 * (e.g. Grafana Cloud).
 *
 * Usage:
 *   import { metrics } from '../lib/metrics';
 *   metrics.counter('http.requests_total', 1, { method: 'GET', route: '/health' });
 *   metrics.histogram('http.duration_ms', 42, { method: 'GET' });
 *   await metrics.pushAndLog('https://otlp.gateway.grafana.net/otlp', 'Basic ...', env);
 */

export interface MetricAttributes {
  [key: string]: string;
}

interface CounterPoint {
  value: number;
  attributes: MetricAttributes;
}

interface GaugePoint {
  value: number;
  attributes: MetricAttributes;
}

interface HistogramPoint {
  values: number[];
  attributes: MetricAttributes;
}

class MetricsRegistry {
  private counters = new Map<string, CounterPoint[]>();
  private gauges = new Map<string, GaugePoint[]>();
  private histograms = new Map<string, HistogramPoint[]>();
  private hasData = false;

  counter(name: string, delta: number, attrs?: MetricAttributes): void {
    const key = this.metricKey(name, attrs);
    const points = this.counters.get(key) ?? [];
    points.push({ value: delta, attributes: attrs ?? {} });
    this.counters.set(key, points);
    this.hasData = true;
  }

  gauge(name: string, value: number, attrs?: MetricAttributes): void {
    const key = this.metricKey(name, attrs);
    this.gauges.set(key, [{ value, attributes: attrs ?? {} }]);
    this.hasData = true;
  }

  histogram(name: string, value: number, attrs?: MetricAttributes): void {
    const key = this.metricKey(name, attrs);
    const points = this.histograms.get(key) ?? [];
    points.push({ values: [value], attributes: attrs ?? {} });
    this.histograms.set(key, points);
    this.hasData = true;
  }

  /** Serialise all buffered metrics as OTLP/JSON and clear buffers. Returns null if empty. */
  flush(environment: string): string | null {
    if (!this.hasData) return null;

    const now = Date.now();
    const nowNano = String(BigInt(now) * BigInt(1_000_000));

    const scopeMetrics: unknown[] = [];

    // ── Counters ──
    const counterByName = new Map<string, { attrs: MetricAttributes; sum: number }[]>();
    for (const [key, points] of this.counters) {
      const name = key.includes(':') ? key.slice(0, key.indexOf(':')) : key;
      let sum = 0;
      for (const p of points) sum += p.value;
      const existing = counterByName.get(name) ?? [];
      existing.push({ attrs: points[0]?.attributes ?? {}, sum });
      counterByName.set(name, existing);
    }
    for (const [name, points] of counterByName) {
      scopeMetrics.push({
        name: `app_registry_${name.replace(/\./g, '_')}`,
        unit: '1',
        sum: {
          dataPoints: points.map((p) => ({
            startTimeUnixNano: nowNano,
            timeUnixNano: nowNano,
            asDouble: p.sum,
            attributes: this.attrsToOTLP(p.attrs),
          })),
          aggregationTemporality: 'AGGREGATION_TEMPORALITY_DELTA',
          isMonotonic: true,
        },
      });
    }

    // ── Gauges ──
    for (const [key, points] of this.gauges) {
      const name = key.includes(':') ? key.slice(0, key.indexOf(':')) : key;
      scopeMetrics.push({
        name: `app_registry_${name.replace(/\./g, '_')}`,
        unit: '1',
        gauge: {
          dataPoints: points.map((p) => ({
            startTimeUnixNano: nowNano,
            timeUnixNano: nowNano,
            asDouble: p.value,
            attributes: this.attrsToOTLP(p.attributes),
          })),
        },
      });
    }

    // ── Histograms ──
    const HISTOGRAM_BUCKETS = [10, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
    function bucketCounts(values: number[]): number[] {
      const counts = new Array(HISTOGRAM_BUCKETS.length + 1).fill(0);
      for (const v of values) {
        let bucket = HISTOGRAM_BUCKETS.length;
        for (let i = 0; i < HISTOGRAM_BUCKETS.length; i++) {
          if (v <= HISTOGRAM_BUCKETS[i]) { bucket = i; break; }
        }
        counts[bucket]++;
      }
      // Cumulative counts are required by Prometheus-style histograms.
      for (let i = 1; i < counts.length; i++) counts[i] += counts[i - 1];
      return counts;
    }

    const histByName = new Map<string, { attrs: MetricAttributes; sum: number; count: number; values: number[] }[]>();
    for (const [key, points] of this.histograms) {
      const name = key.includes(':') ? key.slice(0, key.indexOf(':')) : key;
      let sum = 0;
      let count = 0;
      const values: number[] = [];
      for (const p of points) {
        sum += p.values.reduce((a, b) => a + b, 0);
        count += p.values.length;
        values.push(...p.values);
      }
      const existing = histByName.get(name) ?? [];
      existing.push({ attrs: points[0]?.attributes ?? {}, sum, count, values });
      histByName.set(name, existing);
    }
    for (const [name, points] of histByName) {
      scopeMetrics.push({
        name: `app_registry_${name.replace(/\./g, '_')}`,
        unit: 'ms',
        histogram: {
          dataPoints: points.map((p) => ({
            startTimeUnixNano: nowNano,
            timeUnixNano: nowNano,
            count: String(p.count),
            sum: p.sum,
            bucketCounts: bucketCounts(p.values).map(String),
            explicitBounds: HISTOGRAM_BUCKETS,
            attributes: this.attrsToOTLP(p.attrs),
          })),
          aggregationTemporality: 'AGGREGATION_TEMPORALITY_DELTA',
        },
      });
    }

    if (scopeMetrics.length === 0) {
      this.clear();
      return null;
    }

    const payload = {
      resourceMetrics: [{
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: 'construct-app-registry' } },
            { key: 'service.version', value: { stringValue: '1.0.1' } },
            { key: 'deployment.environment', value: { stringValue: environment } },
          ],
          droppedAttributesCount: 0,
        },
        scopeMetrics: [{
          scope: { name: 'construct-app-registry', version: '1.0.1' },
          metrics: scopeMetrics,
        }],
      }],
    };

    this.clear();
    return JSON.stringify(payload);
  }

  /** POST buffered metrics to an OTLP endpoint and log the outcome. */
  async pushAndLog(endpoint: string, authHeader: string, environment: string): Promise<boolean> {
    const body = this.flush(environment);
    if (!body) return true;

    const url = `${endpoint.replace(/\/$/, '')}/v1/metrics`;

    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: authHeader.replace(/^Authorization:\s*/i, '').trim(),
        },
        body,
      });
      if (resp.ok) {
        console.log(JSON.stringify({ source: 'metrics', level: 'info', event: 'push_ok', status: resp.status, url }));
        return true;
      }
      const errText = await resp.text().catch(() => '');
      console.warn(JSON.stringify({ source: 'metrics', level: 'warn', event: 'push_failed', status: resp.status, url, error: errText.slice(0, 500) }));
      return false;
    } catch (err) {
      console.error(JSON.stringify({ source: 'metrics', level: 'error', event: 'push_error', url, error: err instanceof Error ? err.message : String(err) }));
      return false;
    }
  }

  private clear(): void {
    this.counters.clear();
    this.gauges.clear();
    this.histograms.clear();
    this.hasData = false;
  }

  private metricKey(name: string, attrs?: MetricAttributes): string {
    if (!attrs || Object.keys(attrs).length === 0) return name;
    const sorted = Object.entries(attrs).sort(([a], [b]) => a.localeCompare(b));
    return `${name}:${sorted.map(([k, v]) => `${k}=${v}`).join(',')}`;
  }

  private attrsToOTLP(attrs: MetricAttributes): Array<{ key: string; value: { stringValue: string } }> {
    return Object.entries(attrs).map(([key, value]) => ({
      key,
      value: { stringValue: value },
    }));
  }
}

export const metrics = new MetricsRegistry();
