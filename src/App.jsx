import { useEffect, useMemo, useRef, useState } from 'react';
import { onAuthStateChanged, signInWithPopup, signOut } from 'firebase/auth';
import { auth, googleProvider } from './firebase';

const csvStorageKey = 'automl:uploadedCsv';
const processSections = [
  {
    id: 'data-analysis',
    title: 'Data Analysis',
    items: [
      'Statistics',
      'Outlier Detection',
      'Duplication Detection',
      'Correlation Analysis',
      'Scatter Plot Analysis',
      'Dataset Cartography (mislabel and noise analysis)',
    ],
  },
  {
    id: 'data-transformation',
    title: 'Data Transformation',
    items: ['One Hot Encoding', 'Label Encoding', 'Standardization', 'Splitting'],
  },
  {
    id: 'model-training',
    title: 'Model Training',
    items: ['Model Suggestion', 'Model Building Job'],
  },
  {
    id: 'model-evaluation',
    title: 'Model Evaluation',
    items: ['Testing', 'Interpretability Analysis (SHAP)', 'Accuracy Metrics', 'ROC Curve'],
  },
];

function toNumberOrNull(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function getPercentile(sortedValues, percentile) {
  if (!sortedValues.length) {
    return null;
  }
  if (sortedValues.length === 1) {
    return sortedValues[0];
  }

  const position = (sortedValues.length - 1) * percentile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) {
    return sortedValues[lower];
  }

  const weight = position - lower;
  return sortedValues[lower] + (sortedValues[upper] - sortedValues[lower]) * weight;
}

function formatStat(value) {
  if (value === null || value === undefined) {
    return '—';
  }
  if (Number.isInteger(value)) {
    return value.toString();
  }
  return value.toFixed(4).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}

function buildColumnAnalyses(headers, rows) {
  if (!headers.length) {
    return [];
  }

  return headers.map((header, columnIndex) => {
    const columnName = header || `Column ${columnIndex + 1}`;
    const values = rows
      .map((row) => row[columnIndex] ?? '')
      .map((value) => String(value).trim())
      .filter((value) => value !== '');

    if (!values.length) {
      return {
        columnName,
        kind: 'empty',
        count: 0,
        min: null,
        max: null,
        p25: null,
        p50: null,
        p75: null,
        classCounts: [],
      };
    }

    const numericValues = values.map(toNumberOrNull);
    const isNumeric = numericValues.every((value) => value !== null);

    if (isNumeric) {
      const sorted = numericValues.slice().sort((a, b) => a - b);
      const p25 = getPercentile(sorted, 0.25);
      const p50 = getPercentile(sorted, 0.5);
      const p75 = getPercentile(sorted, 0.75);
      const iqr = p75 - p25;
      const lowerFence = p25 - 1.5 * iqr;
      const upperFence = p75 + 1.5 * iqr;
      const outliers = sorted.filter((value) => value < lowerFence || value > upperFence);

      return {
        columnName,
        kind: 'numeric',
        count: sorted.length,
        min: sorted[0],
        max: sorted[sorted.length - 1],
        p25,
        p50,
        p75,
        classCounts: [],
        lowerFence,
        upperFence,
        outliers,
        outlierCount: outliers.length,
        outlierRate: (outliers.length / sorted.length) * 100,
      };
    }

    const classMap = values.reduce((accumulator, value) => {
      accumulator.set(value, (accumulator.get(value) ?? 0) + 1);
      return accumulator;
    }, new Map());

    return {
      columnName,
      kind: 'categorical',
      count: values.length,
      min: null,
      max: null,
      p25: null,
      p50: null,
      p75: null,
      classCounts: Array.from(classMap.entries()).sort((a, b) => b[1] - a[1]),
    };
  });
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = '';
  let inQuotes = false;

  const source = text.replace(/^\uFEFF/, '');

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const nextCharacter = source[index + 1];

    if (inQuotes) {
      if (character === '"' && nextCharacter === '"') {
        value += '"';
        index += 1;
      } else if (character === '"') {
        inQuotes = false;
      } else {
        value += character;
      }
      continue;
    }

    if (character === '"') {
      inQuotes = true;
      continue;
    }

    if (character === ',') {
      row.push(value);
      value = '';
      continue;
    }

    if (character === '\n') {
      row.push(value);
      rows.push(row);
      row = [];
      value = '';
      continue;
    }

    if (character === '\r') {
      continue;
    }

    value += character;
  }

  if (value.length > 0 || row.length > 0) {
    row.push(value);
    rows.push(row);
  }

  return rows.filter((currentRow) => currentRow.some((cell) => cell.trim() !== ''));
}

function UploadMenu({ onPickCsv, fileName }) {
  const fileInputRef = useRef(null);
  const [open, setOpen] = useState(false);

  return (
    <div className="upload-menu">
      <button
        className="toolbar-button toolbar-button--primary"
        type="button"
        onClick={() => setOpen((current) => !current)}
      >
        Upload
        <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="upload-menu__popover">
          <button
            className="upload-menu__item"
            type="button"
            onClick={() => {
              fileInputRef.current?.click();
              setOpen(false);
            }}
          >
            Upload CSV
          </button>
          <div className="upload-menu__hint">
            {fileName ? `Loaded: ${fileName}` : 'Choose a .csv file to populate the grid.'}
          </div>
        </div>
      )}
      <input
        ref={fileInputRef}
        className="sr-only"
        type="file"
        accept=".csv,text/csv"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) {
            onPickCsv(file);
          }
          event.target.value = '';
        }}
      />
    </div>
  );
}

function LoginScreen({ onLogin, busy }) {
  return (
    <main className="auth-shell">
      <section className="auth-hero">
        <div className="auth-hero__mark" aria-hidden="true" />
        <div className="auth-hero__copy">
          <p className="eyebrow">Private AutoML console</p>
          <h1>Analyse data without turning it into a black box.</h1>
          <p>
            Upload a CSV, inspect its structure, and review model-ready summaries in a workflow
            built for privacy, interpretability, and minimal setup.
          </p>
        </div>
        <div className="auth-hero__ring auth-hero__ring--large" aria-hidden="true" />
        <div className="auth-hero__ring auth-hero__ring--small" aria-hidden="true" />
      </section>

      <section className="auth-card">
        <div className="auth-card__frame">
          <div className="auth-card__content auth-card__content--login">
            <div className="login-badge" aria-hidden="true" />
            <button className="login-button" type="button" onClick={onLogin} disabled={busy}>
              {busy ? 'Opening Google...' : 'Sign in with Google'}
            </button>
          </div>
        </div>
      </section>
    </main>
  );
}

function DataPanel({ headers, rows, fileName }) {
  if (!rows.length) {
    return (
      <div className="empty-state">
        <div className="empty-state__glyph">⇄</div>
        <h3>No CSV loaded yet</h3>
        <p>Use the Upload menu in the toolbar to choose a CSV file.</p>
      </div>
    );
  }

  const limitedRows = rows.slice(0, 1000);

  return (
    <div className="table-shell">
      <div className="table-shell__header">
        <div>
          <p className="eyebrow">Spreadsheet view</p>
          <h3>{fileName || 'Uploaded CSV'}</h3>
        </div>
        <div className="table-shell__meta">
          <span>{limitedRows.length} rows shown</span>
          <span>{headers.length} columns</span>
        </div>
      </div>

      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th className="row-number">#</th>
              {headers.map((header, index) => (
                <th key={`${header}-${index}`}>{header || `Column ${index + 1}`}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {limitedRows.map((row, rowIndex) => (
              <tr key={`${rowIndex}-${row.join('|')}`}>
                <td className="row-number">{rowIndex + 1}</td>
                {headers.map((_, columnIndex) => (
                  <td key={`${rowIndex}-${columnIndex}`}>
                    <span>{row[columnIndex] ?? ''}</span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatisticsTable({ analyses }) {
  const stats = analyses;

  if (!stats.length) {
    return (
      <div className="process-empty">
        <strong>Statistics</strong>
        <p>Upload a CSV to generate per-column statistics and class distributions.</p>
      </div>
    );
  }

  return (
    <section className="analysis-block">
      <h4>Statistics</h4>
      <div className="stats-table-wrap">
      <table className="stats-table">
        <thead>
          <tr>
            <th>Column</th>
            <th>Type</th>
            <th>Count</th>
            <th>Min</th>
            <th>Max</th>
            <th>P25</th>
            <th>P50</th>
            <th>P75</th>
            <th>Class Counts</th>
          </tr>
        </thead>
        <tbody>
          {stats.map((column) => (
            <tr key={column.columnName}>
              <td>{column.columnName}</td>
              <td>{column.kind}</td>
              <td>{column.count}</td>
              <td>{formatStat(column.min)}</td>
              <td>{formatStat(column.max)}</td>
              <td>{formatStat(column.p25)}</td>
              <td>{formatStat(column.p50)}</td>
              <td>{formatStat(column.p75)}</td>
              <td>
                {column.kind === 'categorical' ? (
                  <div className="class-counts">
                    {column.classCounts.map(([label, count]) => (
                      <span key={`${column.columnName}-${label}`}>
                        {label}: {count}
                      </span>
                    ))}
                  </div>
                ) : (
                  '—'
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </section>
  );
}

function OutlierSection({ analyses }) {
  const numericColumns = analyses.filter((column) => column.kind === 'numeric');

  if (!numericColumns.length) {
    return (
      <section className="analysis-block">
        <h4>Outlier Detection</h4>
        <div className="process-empty">
          <strong>No numeric columns available</strong>
          <p>Upload a CSV with numeric attributes to generate boxplots and outlier estimates.</p>
        </div>
      </section>
    );
  }

  const outlierColors = ['#C33C54', '#254E70', '#37718E', '#8EE3EF', '#AEF3E7'];
  const plotWidth = 520;
  const plotHeight = 46;
  const leftPadding = 12;
  const rightPadding = 12;
  const axisStart = leftPadding;
  const axisEnd = plotWidth - rightPadding;
  const axisSize = axisEnd - axisStart;

  return (
    <section className="analysis-block">
      <h4>Outlier Detection</h4>
      <div className="boxplot-stack">
        {numericColumns.map((column, index) => {
          const min = column.min;
          const max = column.max;
          const range = max - min;
          const mapToX = (value) => {
            if (!Number.isFinite(range) || range === 0) {
              return axisStart + axisSize / 2;
            }
            return axisStart + ((value - min) / range) * axisSize;
          };

          const xMin = mapToX(column.min);
          const xP25 = mapToX(column.p25);
          const xP50 = mapToX(column.p50);
          const xP75 = mapToX(column.p75);
          const xMax = mapToX(column.max);
          const yCenter = plotHeight / 2;
          const boxTop = 10;
          const boxHeight = 24;

          return (
            <div className="boxplot-row" key={column.columnName}>
              <div className="boxplot-row__meta">
                <strong>{column.columnName}</strong>
                <span>
                  Outliers: {column.outlierCount} ({formatStat(column.outlierRate)}%)
                </span>
              </div>

              <svg
                className="boxplot-svg"
                viewBox={`0 0 ${plotWidth} ${plotHeight}`}
                role="img"
                aria-label={`Boxplot for ${column.columnName}`}
              >
                <line x1={xMin} y1={yCenter} x2={xMax} y2={yCenter} stroke="#254E70" strokeWidth="2" />
                <line x1={xMin} y1="14" x2={xMin} y2="32" stroke="#37718E" strokeWidth="2" />
                <line x1={xMax} y1="14" x2={xMax} y2="32" stroke="#37718E" strokeWidth="2" />

                <rect
                  x={Math.min(xP25, xP75)}
                  y={boxTop}
                  width={Math.max(Math.abs(xP75 - xP25), 2)}
                  height={boxHeight}
                  fill="rgba(142, 227, 239, 0.5)"
                  stroke="#254E70"
                  strokeWidth="2"
                />
                <line x1={xP50} y1={boxTop} x2={xP50} y2={boxTop + boxHeight} stroke="#C33C54" strokeWidth="3" />

                {column.outliers.map((value, outlierIndex) => (
                  <circle
                    key={`${column.columnName}-outlier-${outlierIndex}-${value}`}
                    cx={mapToX(value)}
                    cy={yCenter}
                    r="4.5"
                    fill={outlierColors[(index + outlierIndex) % outlierColors.length]}
                    stroke="#000000"
                    strokeWidth="1"
                  />
                ))}
              </svg>
            </div>
          );
        })}
      </div>

      <div className="stats-table-wrap">
        <table className="stats-table">
          <thead>
            <tr>
              <th>Attribute</th>
              <th>Count</th>
              <th>Lower Fence</th>
              <th>Upper Fence</th>
              <th>Outlier Count</th>
              <th>Outlier %</th>
            </tr>
          </thead>
          <tbody>
            {numericColumns.map((column) => (
              <tr key={`outlier-${column.columnName}`}>
                <td>{column.columnName}</td>
                <td>{column.count}</td>
                <td>{formatStat(column.lowerFence)}</td>
                <td>{formatStat(column.upperFence)}</td>
                <td>{column.outlierCount}</td>
                <td>{formatStat(column.outlierRate)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ProcessPanel({ headers, rows }) {
  const [openSection, setOpenSection] = useState(processSections[0].id);
  const analyses = useMemo(() => buildColumnAnalyses(headers, rows), [headers, rows]);

  return (
    <div className="process-shell">
      <div className="process-shell__header">
        <p className="eyebrow">Workflow</p>
        <h3>Process Panel</h3>
      </div>

      <div className="process-accordion" role="tablist" aria-label="Process sections">
        {processSections.map((section, sectionIndex) => {
          const isOpen = openSection === section.id;
          return (
            <section
              className={`process-section${isOpen ? ' process-section--open' : ''}`}
              key={section.id}
            >
              <button
                className="process-section__trigger"
                type="button"
                role="tab"
                aria-selected={isOpen}
                aria-expanded={isOpen}
                onClick={() => setOpenSection(section.id)}
              >
                <span>{section.title}</span>
                <span className="process-section__symbol" aria-hidden="true">
                  {isOpen ? '−' : '+'}
                </span>
              </button>

              <div
                className={`process-section__content${isOpen ? ' process-section__content--open' : ''}`}
                role="tabpanel"
                aria-hidden={!isOpen}
              >
                <div className="process-section__content-inner">
                  {section.id === 'data-analysis' ? (
                    <>
                      <StatisticsTable analyses={analyses} />
                      <OutlierSection analyses={analyses} />
                      <ul className="process-list">
                        {section.items.slice(2).map((item) => (
                          <li key={item}>{item}</li>
                        ))}
                      </ul>
                    </>
                  ) : (
                    <ul className="process-list">
                      {section.items.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function App() {
  const [user, setUser] = useState(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [fileName, setFileName] = useState('');
  const [rows, setRows] = useState([]);
  const [error, setError] = useState('');

  useEffect(() => onAuthStateChanged(auth, setUser), []);

  useEffect(() => {
    const savedCsv = window.sessionStorage.getItem(csvStorageKey);
    if (!savedCsv) {
      return;
    }

    try {
      const parsed = JSON.parse(savedCsv);
      if (Array.isArray(parsed?.rows)) {
        setFileName(typeof parsed.fileName === 'string' ? parsed.fileName : '');
        setRows(parsed.rows);
      }
    } catch {
      window.sessionStorage.removeItem(csvStorageKey);
    }
  }, []);

  useEffect(() => {
    if (!rows.length) {
      window.sessionStorage.removeItem(csvStorageKey);
      return;
    }

    window.sessionStorage.setItem(
      csvStorageKey,
      JSON.stringify({ fileName, rows }),
    );
  }, [fileName, rows]);

  const headers = useMemo(() => (rows[0] ? rows[0] : []), [rows]);
  const tableRows = useMemo(() => (rows.length > 1 ? rows.slice(1) : []), [rows]);

  const handleLogin = async () => {
    setError('');
    setAuthBusy(true);
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (loginError) {
      setError(loginError?.message || 'Google sign-in failed.');
    } finally {
      setAuthBusy(false);
    }
  };

  const handleCsvFile = async (file) => {
    setError('');
    const text = await file.text();
    const parsedRows = parseCsv(text);
    if (!parsedRows.length) {
      setRows([]);
      setFileName(file.name);
      setError('The uploaded file did not contain any visible CSV rows.');
      return;
    }

    setFileName(file.name);
    setRows(parsedRows);
  };

  const handleCloseProject = () => {
    setError('');
    setFileName('');
    setRows([]);
    window.sessionStorage.removeItem(csvStorageKey);
  };

  if (!user) {
    return <LoginScreen onLogin={handleLogin} busy={authBusy} />;
  }

  return (
    <div className="dashboard-shell">
      <header className="topbar">
        <div className="topbar__brand">
          <div className="topbar__mark" />
          <div>
            <p>Private analysis console</p>
            <h1>Dataset workspace</h1>
          </div>
        </div>

        <div className="topbar__actions">
          <UploadMenu onPickCsv={handleCsvFile} fileName={fileName} />
          <button className="toolbar-button" type="button" onClick={handleCloseProject}>
            Close project
          </button>
          <button className="toolbar-button" type="button" onClick={() => signOut(auth)}>
            Sign out
          </button>
        </div>
      </header>

      {error && <div className="notice">{error}</div>}

      <main className="workspace workspace--split">
        <aside className="panel panel--left panel--process">
          <div className="panel__glow panel__glow--left" />
          <div className="panel__content panel__content--process">
            <ProcessPanel headers={headers} rows={tableRows} />
          </div>
        </aside>

        <section className="panel panel--right panel--csv">
          <div className="panel__glow panel__glow--right" />
          <div className="panel__content panel__content--tight">
            <DataPanel headers={headers} rows={tableRows} fileName={fileName} />
          </div>
        </section>
      </main>
    </div>
  );
}

export default App;