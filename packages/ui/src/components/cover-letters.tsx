import { useState, useEffect } from 'react';
import axios from 'axios';

export interface CoverLetterJob {
  id: string;
  title: string;
  company: string;
  matched_skills: string[];
  fit_score: number;
  source: string;
  cover_letter: string;
  generated_at: string;
  is_adhoc?: boolean;
}

interface CoverLettersPageProps {
  jobs: CoverLetterJob[];
  onRefresh: () => Promise<void> | void;
}

export function CoverLettersPage({ jobs, onRefresh }: CoverLettersPageProps) {
  const [selected, setSelected] = useState<CoverLetterJob | null>(null);
  const [copied, setCopied] = useState(false);
  const [search, setSearch] = useState('');

  const [showPasteModal, setShowPasteModal] = useState(false);
  const [pasteDescription, setPasteDescription] = useState('');
  const [pasteTitle, setPasteTitle] = useState('');
  const [pasteCompany, setPasteCompany] = useState('');
  const [pasteGenerating, setPasteGenerating] = useState(false);
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [pendingSelectId, setPendingSelectId] = useState<string | null>(null);

  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const filtered = search
    ? jobs.filter((j) =>
        j.title.toLowerCase().includes(search.toLowerCase()) ||
        j.company.toLowerCase().includes(search.toLowerCase()) ||
        j.matched_skills.some((s) => s.toLowerCase().includes(search.toLowerCase()))
      )
    : jobs;

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Auto-select first job
  useEffect(() => {
    if (!selected && filtered.length > 0) setSelected(filtered[0]);
  }, [filtered, selected]);

  // Once a freshly-generated adhoc letter shows up in the refetched list, select it.
  useEffect(() => {
    if (!pendingSelectId) return;
    const found = jobs.find((j) => j.id === pendingSelectId);
    if (found) {
      setSelected(found);
      setPendingSelectId(null);
    }
  }, [jobs, pendingSelectId]);

  const openPasteModal = () => {
    setPasteDescription('');
    setPasteTitle('');
    setPasteCompany('');
    setPasteError(null);
    setShowPasteModal(true);
  };

  const handleGenerateFromDescription = async () => {
    if (!pasteDescription.trim()) {
      setPasteError('Paste a job description first.');
      return;
    }
    setPasteGenerating(true);
    setPasteError(null);
    try {
      const { data } = await axios.post<{ id: string }>('/api/jobs/adhoc-cover-letter', {
        description: pasteDescription,
        title: pasteTitle || undefined,
        company: pasteCompany || undefined,
      });
      setShowPasteModal(false);
      setPendingSelectId(data.id);
      await onRefresh();
    } catch (err: any) {
      setPasteError(err.response?.data?.message || 'Failed to generate cover letter');
    } finally {
      setPasteGenerating(false);
    }
  };

  const startEditing = () => {
    if (!selected) return;
    setEditText(selected.cover_letter);
    setSaveError(null);
    setEditing(true);
  };

  const cancelEditing = () => {
    setEditing(false);
    setSaveError(null);
  };

  const saveEdit = async () => {
    if (!selected) return;
    if (!editText.trim()) {
      setSaveError('Cover letter cannot be empty.');
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      await axios.put(`/api/jobs/${selected.id}/cover-letter`, { content: editText });
      setSelected({ ...selected, cover_letter: editText });
      setEditing(false);
      await onRefresh();
    } catch (err: any) {
      setSaveError(err.response?.data?.message || 'Failed to save edit');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="cl-page">
      <div className="cl-sidebar">
        <div className="cl-search">
          <input
            className="cl-search-input"
            placeholder="Search by title, company, or skill..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <button className="cl-new-btn" onClick={openPasteModal} title="Generate from a pasted description">
            + New
          </button>
        </div>
        <div className="cl-list">
          {jobs.length === 0 && (
            <div className="empty-state">
              <p>No cover letters generated yet. Open a job and click "Generate Cover Letter", or paste a description above.</p>
            </div>
          )}
          {filtered.map((job) => (
            <div
              key={job.id}
              className={`cl-item ${selected?.id === job.id ? 'active' : ''}`}
              onClick={() => { setSelected(job); setCopied(false); setEditing(false); }}
            >
              <div className="cl-item-header">
                <span className="cl-item-title">{job.title}</span>
                {!job.is_adhoc && (
                  <span className={`score ${job.fit_score >= 7 ? 'high' : job.fit_score >= 5 ? 'mid' : 'low'}`}>
                    {job.fit_score}
                  </span>
                )}
              </div>
              <div className="cl-item-company">{job.company}</div>
              {!job.is_adhoc && (
                <div className="cl-item-skills">
                  {job.matched_skills.slice(0, 4).map((s) => (
                    <span key={s} className="skill-tag">{s}</span>
                  ))}
                  {job.matched_skills.length > 4 && (
                    <span className="skill-tag">+{job.matched_skills.length - 4}</span>
                  )}
                </div>
              )}
            </div>
          ))}
          {jobs.length > 0 && filtered.length === 0 && (
            <div className="cl-no-results">No matches for "{search}"</div>
          )}
        </div>
      </div>

      <div className="cl-main">
        {selected ? (
          <>
            <div className="cl-preview-header">
              <div>
                <div className="cl-preview-title">{selected.title}</div>
                <div className="cl-preview-company">
                  {selected.company}
                  {!selected.is_adhoc && (
                    <span className={`platform ${selected.source}`} style={{ marginLeft: '10px' }}>{selected.source}</span>
                  )}
                </div>
                {!selected.is_adhoc && (
                  <div className="cl-preview-skills">
                    {selected.matched_skills.map((s) => (
                      <span key={s} className="skill-tag">{s}</span>
                    ))}
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', gap: '8px' }}>
                {!editing && (
                  <button className="cl-edit-btn" onClick={startEditing}>
                    Edit
                  </button>
                )}
                <button
                  className="cl-copy-btn"
                  onClick={() => copyToClipboard(editing ? editText : selected.cover_letter)}
                >
                  {copied ? 'Copied!' : 'Copy to Clipboard'}
                </button>
              </div>
            </div>

            {editing ? (
              <div className="cl-edit-block">
                <textarea
                  className="cl-edit-textarea"
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  disabled={saving}
                />
                {saveError && <p className="generate-error">{saveError}</p>}
                <div className="cl-edit-actions">
                  <button className="cancel-select-btn" onClick={cancelEditing} disabled={saving}>
                    Cancel
                  </button>
                  <button className="generate-btn" onClick={saveEdit} disabled={saving}>
                    {saving ? 'Saving...' : 'Save'}
                  </button>
                </div>
              </div>
            ) : (
              <pre className="cl-content">{selected.cover_letter}</pre>
            )}
          </>
        ) : (
          <div className="empty-state"><p>Select a job to view its cover letter</p></div>
        )}
      </div>

      {showPasteModal && (
        <div className="modal-overlay" onClick={() => !pasteGenerating && setShowPasteModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Generate from a description</h2>
              <button className="modal-close" onClick={() => setShowPasteModal(false)} disabled={pasteGenerating}>&times;</button>
            </div>
            <div className="modal-section">
              <h3>Title (optional)</h3>
              <input
                className="search-input"
                style={{ width: '100%' }}
                value={pasteTitle}
                onChange={(e) => setPasteTitle(e.target.value)}
                placeholder="e.g. Senior Backend Engineer"
                disabled={pasteGenerating}
              />
            </div>
            <div className="modal-section">
              <h3>Company (optional)</h3>
              <input
                className="search-input"
                style={{ width: '100%' }}
                value={pasteCompany}
                onChange={(e) => setPasteCompany(e.target.value)}
                placeholder="e.g. Acme"
                disabled={pasteGenerating}
              />
            </div>
            <div className="modal-section">
              <h3>Job description</h3>
              <textarea
                className="cl-edit-textarea"
                style={{ minHeight: '220px' }}
                value={pasteDescription}
                onChange={(e) => setPasteDescription(e.target.value)}
                placeholder="Paste the full job description here..."
                disabled={pasteGenerating}
              />
            </div>
            {pasteError && <p className="generate-error">{pasteError}</p>}
            <div className="cl-edit-actions">
              <button className="cancel-select-btn" onClick={() => setShowPasteModal(false)} disabled={pasteGenerating}>
                Cancel
              </button>
              <button className="generate-btn" onClick={handleGenerateFromDescription} disabled={pasteGenerating}>
                {pasteGenerating ? 'Generating...' : 'Generate'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
