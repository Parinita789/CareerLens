import { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import type { PipelineStatus } from '../types';

interface Phase {
  id: string;
  label: string;
}

const PHASE_DESCRIPTIONS: Record<string, string> = {
  scrape: 'Select platforms below',
  'gmail-alerts': 'Checks Gmail every 1 hr',
  apply: 'Select platforms below',
};

const APPLY_PLATFORMS = [
  { id: 'linkedin', label: 'LinkedIn' },
  { id: 'greenhouse', label: 'Greenhouse' },
];

const SCRAPE_SOURCES = [
  { id: 'linkedin', label: 'LinkedIn' },
  { id: 'greenhouse', label: 'Greenhouse' },
  { id: 'ashby', label: 'Ashby' },
  { id: 'lever', label: 'Lever' },
  { id: 'indeed', label: 'Indeed' },
];

interface CommandPanelProps {
  isOpen: boolean;
  onClose: () => void;
  onComplete: () => void;
}

export function CommandPanel({ isOpen, onClose, onComplete }: CommandPanelProps) {
  const [phases, setPhases] = useState<Phase[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectedSources, setSelectedSources] = useState<Set<string>>(new Set(SCRAPE_SOURCES.map((s) => s.id)));
  const [selectedApplyPlatforms, setSelectedApplyPlatforms] = useState<Set<string>>(new Set(APPLY_PLATFORMS.map((p) => p.id)));
  const [applyLimit, setApplyLimit] = useState<number>(1);
  const [status, setStatus] = useState<PipelineStatus | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [logOffset, setLogOffset] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [showBar, setShowBar] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  // Fetch phases on mount
  useEffect(() => {
    axios.get<Phase[]>('/api/pipeline/phases').then(({ data }) => setPhases(data));
  }, []);

  // Fetch status when modal opens or periodically check if pipeline is running
  useEffect(() => {
    if (!isOpen) return;
    axios.get<PipelineStatus>('/api/pipeline/status').then(({ data }) => {
      setStatus(data);
      setLogs(data.logs);
      setLogOffset(data.logs.length);
      if (data.running) setExpanded(true);
    });
  }, [isOpen]);

  // Check for running pipeline on mount (for the bottom bar)
  useEffect(() => {
    axios.get<PipelineStatus>('/api/pipeline/status').then(({ data }) => {
      if (data.running) {
        setStatus(data);
        setLogs(data.logs);
        setLogOffset(data.logs.length);
        setShowBar(true);
      }
    });
  }, []);

  // Poll for logs + status while running
  useEffect(() => {
    if (!status?.running) return;
    const interval = setInterval(async () => {
      try {
        const [statusRes, logsRes] = await Promise.all([
          axios.get<PipelineStatus>('/api/pipeline/status'),
          axios.get<{ logs: string[]; total: number }>(`/api/pipeline/logs?since=${logOffset}`),
        ]);
        setStatus(statusRes.data);
        if (logsRes.data.logs.length > 0) {
          setLogs((prev) => [...prev, ...logsRes.data.logs]);
          setLogOffset(logsRes.data.total);
        }
        if (!statusRes.data.running) {
          clearInterval(interval);
          onComplete();
          // Keep bar visible to show completion
        }
      } catch {
        // ignore
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [status?.running, logOffset, onComplete]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  const togglePhase = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSource = (id: string) => {
    setSelectedSources((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const allSelected = phases.length > 0 && selected.size === phases.length;
  const allSourcesSelected = selectedSources.size === SCRAPE_SOURCES.length;
  const allApplyPlatformsSelected = selectedApplyPlatforms.size === APPLY_PLATFORMS.length;

  const toggleApplyPlatform = (id: string) => {
    setSelectedApplyPlatforms((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAllApplyPlatforms = () => {
    if (allApplyPlatformsSelected) setSelectedApplyPlatforms(new Set());
    else setSelectedApplyPlatforms(new Set(APPLY_PLATFORMS.map((p) => p.id)));
  };
  const toggleAll = () => allSelected ? setSelected(new Set()) : setSelected(new Set(phases.map((p) => p.id)));
  const toggleAllSources = () => allSourcesSelected ? setSelectedSources(new Set()) : setSelectedSources(new Set(SCRAPE_SOURCES.map((s) => s.id)));

  const stopPipeline = async () => {
    try {
      await axios.post('/api/pipeline/stop');
      setStatus((prev) => prev ? { ...prev, running: false, error: 'Stopped by user' } : prev);
    } catch {
      // ignore
    }
  };

  const runSelected = async () => {
    try {
      setLogs([]);
      setLogOffset(0);
      const phaseIds = phases.filter((p) => selected.has(p.id)).map((p) => p.id);
      const scrapeSources = selected.has('scrape') ? Array.from(selectedSources) : undefined;
      const applyPlatforms = selected.has('apply') ? Array.from(selectedApplyPlatforms) : undefined;
      const limitVal = selected.has('apply') ? applyLimit : undefined;
      await axios.post('/api/pipeline/run-phases', { phases: phaseIds, scrapeSources, applyPlatforms, applyLimit: limitVal });
      setStatus({
        running: true,
        phase: 'starting',
        command: phaseIds.length === phases.length ? 'Full Pipeline' : `${phaseIds.length} phases`,
        error: null,
        lastRunAt: null,
        logs: [],
      });
      setShowBar(true);
      onClose(); // Close modal, bottom bar takes over
    } catch (err: any) {
      const msg = err.response?.data?.message || 'Failed to start';
      setLogs((prev) => [...prev, `ERROR: ${msg}`]);
    }
  };

  const running = status?.running ?? false;
  const scrapeSelected = selected.has('scrape');
  const applySelected = selected.has('apply');

  // ── Config Modal (when not running) ──
  const configModal = isOpen && !running ? (
    <div className="modal-overlay" onClick={onClose}>
      <div className="command-panel" onClick={(e) => e.stopPropagation()}>
        <div className="command-panel-header">
          <h2>Pipeline</h2>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>

        <div className="phase-checklist">
          <label className="phase-item select-all">
            <input type="checkbox" checked={allSelected} onChange={toggleAll} />
            <span className="phase-label">Select All (Full Pipeline)</span>
          </label>
          {phases.map((phase) => (
            <div key={phase.id}>
              <label className="phase-item">
                <input type="checkbox" checked={selected.has(phase.id)} onChange={() => togglePhase(phase.id)} />
                <span className="phase-label">{phase.label}</span>
                {PHASE_DESCRIPTIONS[phase.id] && <span className="phase-desc">{PHASE_DESCRIPTIONS[phase.id]}</span>}
              </label>
              {phase.id === 'scrape' && scrapeSelected && (
                <div className="source-picker">
                  <label className="source-item">
                    <input type="checkbox" checked={allSourcesSelected} onChange={toggleAllSources} />
                    <span>All platforms</span>
                  </label>
                  {SCRAPE_SOURCES.map((src) => (
                    <label key={src.id} className="source-item">
                      <input type="checkbox" checked={selectedSources.has(src.id)} onChange={() => toggleSource(src.id)} />
                      <span>{src.label}</span>
                    </label>
                  ))}
                </div>
              )}
              {phase.id === 'apply' && applySelected && (
                <div className="source-picker">
                  <label className="source-item">
                    <input type="checkbox" checked={allApplyPlatformsSelected} onChange={toggleAllApplyPlatforms} />
                    <span>All platforms</span>
                  </label>
                  {APPLY_PLATFORMS.map((p) => (
                    <label key={p.id} className="source-item">
                      <input type="checkbox" checked={selectedApplyPlatforms.has(p.id)} onChange={() => toggleApplyPlatform(p.id)} />
                      <span>{p.label}</span>
                    </label>
                  ))}
                  <div className="apply-limit">
                    <span>Limit:</span>
                    <input
                      type="number"
                      min={1}
                      value={applyLimit}
                      onChange={(e) => setApplyLimit(Math.max(1, parseInt(e.target.value) || 1))}
                    />
                    <span className="apply-limit-hint">jobs</span>
                  </div>
                </div>
              )}
            </div>
          ))}
          <div className="pipeline-actions">
            <button
              className="run-btn"
              disabled={selected.size === 0 || (scrapeSelected && selectedSources.size === 0) || (applySelected && selectedApplyPlatforms.size === 0)}
              onClick={runSelected}
            >
              Run {selected.size === phases.length ? 'Full Pipeline' : `${selected.size} Phase${selected.size !== 1 ? 's' : ''}`}
            </button>
          </div>
        </div>

      </div>
    </div>
  ) : null;

  // ── Floating Bottom Bar (visible while running + after completion) ──
  const finished = showBar && !running && status?.lastRunAt;
  const failed = showBar && !running && status?.error;

  const bottomBar = showBar ? (
    <div className={`pipeline-bar ${expanded ? 'expanded' : ''} ${finished ? 'done' : ''} ${failed ? 'errored' : ''}`}>
      <div className="pipeline-bar-header" onClick={() => setExpanded(!expanded)}>
        <div className="pipeline-bar-status">
          {running && <span className="pipeline-bar-dot" />}
          {finished && !failed && <span className="pipeline-bar-dot done" />}
          {failed && <span className="pipeline-bar-dot errored" />}
          <span className="pipeline-bar-text">
            {running
              ? `${status?.command} — ${status?.phase}`
              : failed
                ? `${status?.command} — ${status?.error}`
                : `${status?.command} — completed`}
          </span>
        </div>
        <div className="pipeline-bar-actions">
          {running && (
            <button className="pipeline-bar-stop" onClick={(e) => { e.stopPropagation(); stopPipeline(); }}>
              Stop
            </button>
          )}
          {!running && (
            <button className="pipeline-bar-dismiss" onClick={(e) => { e.stopPropagation(); setShowBar(false); }}>
              Dismiss
            </button>
          )}
          <button className="pipeline-bar-toggle">
            {expanded ? '▼' : '▲'}
          </button>
        </div>
      </div>
      {expanded && (
        <div className="pipeline-bar-logs" ref={logRef}>
          {logs.map((line, i) => (
            <div key={i} className={`log-line ${logLineClass(line)}`}>{line}</div>
          ))}
        </div>
      )}
    </div>
  ) : null;

  return (
    <>
      {configModal}
      {bottomBar}
    </>
  );
}

function logLineClass(line: string): string {
  if (line.includes('ERROR') || line.includes('[stderr]')) return 'log-error';
  if (line.includes('completed') || line.includes('APPLIED')) return 'log-success';
  if (line.startsWith('[') && line.includes('] ---')) return 'log-header';
  return '';
}
