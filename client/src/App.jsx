import React, { useEffect, useMemo, useRef, useState } from "react";

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function normalizeRect(rect) {
  if (!rect) return null;

  const x = Math.min(rect.x1, rect.x2);
  const y = Math.min(rect.y1, rect.y2);
  const width = Math.abs(rect.x2 - rect.x1);
  const height = Math.abs(rect.y2 - rect.y1);

  return { x, y, width, height };
}

function rectToCss(rect) {
  if (!rect) return null;

  return {
    left: `${rect.x * 100}%`,
    top: `${rect.y * 100}%`,
    width: `${rect.width * 100}%`,
    height: `${rect.height * 100}%`,
  };
}

async function parseJsonSafe(res) {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function parseJsonTextSafe(text) {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function postFormDataWithProgress(
  url,
  formData,
  { onUploadProgress, onUploadComplete } = {}
) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.responseType = "text";

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      const percent = Math.round((event.loaded / event.total) * 100);
      onUploadProgress?.(percent);
    };

    xhr.upload.onload = () => {
      onUploadComplete?.();
    };

    xhr.onload = () => {
      resolve({
        ok: xhr.status >= 200 && xhr.status < 300,
        status: xhr.status,
        text: xhr.responseText,
        getHeader: (name) => xhr.getResponseHeader(name),
      });
    };

    xhr.onerror = () => {
      reject(new Error(`Network error calling ${url}.`));
    };

    xhr.onabort = () => {
      reject(new Error(`Request aborted calling ${url}.`));
    };

    xhr.send(formData);
  });
}

function getFileNameFromDisposition(disposition) {
  if (!disposition) return "";

  const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1]);
    } catch {
      return utf8Match[1];
    }
  }

  const normalMatch = disposition.match(/filename="?([^"]+)"?/i);
  return normalMatch?.[1] || "";
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let i = 0;

  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }

  return `${value.toFixed(value >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function normalizeVendorNameForFile(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function sanitizeFilePart(value, fallback) {
  const clean = String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  return clean || fallback;
}

function makeOfficialFileName(vendorName, invoiceNumber) {
  const vendorPart =
    normalizeVendorNameForFile(vendorName || "UNKNOWN_VENDOR") || "UNKNOWN_VENDOR";
  const invoicePart = sanitizeFilePart(invoiceNumber, "UNKNOWN_INVOICE");
  return `${vendorPart}_${invoicePart}.pdf`;
}

function StatusPill({ children, tone = "info" }) {
  const tones = {
    info: {
      background: "rgba(79, 172, 254, 0.14)",
      border: "1px solid rgba(79, 172, 254, 0.35)",
      color: "#d7eeff",
    },
    success: {
      background: "rgba(91, 214, 141, 0.14)",
      border: "1px solid rgba(91, 214, 141, 0.35)",
      color: "#dfffea",
    },
    warning: {
      background: "rgba(255, 193, 7, 0.14)",
      border: "1px solid rgba(255, 193, 7, 0.35)",
      color: "#fff2c2",
    },
    danger: {
      background: "rgba(255, 107, 107, 0.14)",
      border: "1px solid rgba(255, 107, 107, 0.35)",
      color: "#ffe3e3",
    },
  };

  const style = tones[tone] || tones.info;

  return (
    <span
      style={{
        ...style,
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        padding: "8px 12px",
        borderRadius: 999,
        fontSize: 13,
        fontWeight: 700,
      }}
    >
      {children}
    </span>
  );
}

function ProgressBar({ visible, percent, label }) {
  if (!visible) return null;

  return (
    <div
      style={{
        marginTop: 16,
        borderRadius: 14,
        padding: 14,
        background: "rgba(9, 19, 29, 0.88)",
        border: "1px solid rgba(90, 143, 191, 0.22)",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 12,
          alignItems: "center",
          marginBottom: 10,
          flexWrap: "wrap",
        }}
      >
        <div style={{ color: "#d7eeff", fontWeight: 800 }}>
          {label || "Working..."}
        </div>
        <div style={{ color: "#9fc3df", fontWeight: 800 }}>
          {Math.max(0, Math.min(100, Math.round(percent || 0)))}%
        </div>
      </div>

      <div
        style={{
          width: "100%",
          height: 12,
          borderRadius: 999,
          overflow: "hidden",
          background: "rgba(255,255,255,0.08)",
          border: "1px solid rgba(110, 166, 214, 0.2)",
        }}
      >
        <div
          style={{
            width: `${Math.max(0, Math.min(100, percent || 0))}%`,
            height: "100%",
            borderRadius: 999,
            background:
              "linear-gradient(90deg, rgba(61,145,207,1) 0%, rgba(122,197,255,1) 100%)",
            transition: "width 180ms ease",
          }}
        />
      </div>
    </div>
  );
}

function ResultPreviewPanel({ row, onDownload, onEdit }) {
  if (!row) {
    return (
      <div
        style={{
          borderRadius: 18,
          padding: 18,
          border: "1px solid rgba(85, 140, 190, 0.24)",
          background: "#0b1824",
          color: "#9fc3df",
        }}
      >
        Click a row to preview that page.
      </div>
    );
  }

  return (
    <div
      style={{
        borderRadius: 18,
        padding: 16,
        border: "1px solid rgba(85, 140, 190, 0.24)",
        background: "#0b1824",
      }}
    >
      <div style={{ marginBottom: 12 }}>
        <div style={{ color: "#e7f6ff", fontWeight: 900, fontSize: 20 }}>
          Selected Page Preview
        </div>
        <div style={{ color: "#9fc3df", marginTop: 6, lineHeight: 1.6 }}>
          Page <strong>{row.pageNumber ?? "-"}</strong> · Vendor{" "}
          <strong>{row.vendorName || "-"}</strong> · Invoice{" "}
          <strong>{row.invoiceNumber || "-"}</strong>
        </div>
      </div>

      <div
        style={{
          borderRadius: 16,
          overflow: "hidden",
          border: "1px solid rgba(85, 140, 190, 0.2)",
          background: "#07131d",
          minHeight: 320,
        }}
      >
        {row.previewUrl ? (
          <img
            src={row.previewUrl}
            alt={`Preview page ${row.pageNumber}`}
            style={{
              display: "block",
              width: "100%",
              height: "auto",
            }}
          />
        ) : (
          <div
            style={{
              minHeight: 320,
              display: "grid",
              placeItems: "center",
              color: "#9fc3df",
              padding: 24,
              textAlign: "center",
            }}
          >
            No preview image was returned for this page by the backend.
          </div>
        )}
      </div>

      <div
        style={{
          marginTop: 14,
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: 10,
        }}
      >
        <div
          style={{
            borderRadius: 12,
            padding: 12,
            background: "#0d2233",
            border: "1px solid rgba(85, 140, 190, 0.2)",
          }}
        >
          <div style={{ color: "#d7eeff", fontWeight: 800, marginBottom: 6 }}>
            Vendor
          </div>
          <div style={{ color: "#cbe6fb" }}>{row.vendorName || "-"}</div>
        </div>

        <div
          style={{
            borderRadius: 12,
            padding: 12,
            background: "#0d2233",
            border: "1px solid rgba(85, 140, 190, 0.2)",
          }}
        >
          <div style={{ color: "#d7eeff", fontWeight: 800, marginBottom: 6 }}>
            Invoice Number
          </div>
          <div style={{ color: "#cbe6fb" }}>{row.invoiceNumber || "-"}</div>
        </div>

        <div
          style={{
            borderRadius: 12,
            padding: 12,
            background: "#0d2233",
            border: "1px solid rgba(85, 140, 190, 0.2)",
          }}
        >
          <div style={{ color: "#d7eeff", fontWeight: 800, marginBottom: 6 }}>
            Official File Name
          </div>
          <div style={{ color: "#cbe6fb", wordBreak: "break-word" }}>
            {row.officialFileName || "-"}
          </div>
        </div>
      </div>

      <div
        style={{
          marginTop: 14,
          display: "flex",
          gap: 10,
          flexWrap: "wrap",
        }}
      >
        <button
          type="button"
          onClick={() => onEdit?.(row)}
          style={{
            padding: "12px 16px",
            borderRadius: 12,
            border: "1px solid rgba(110, 166, 214, 0.35)",
            background: "#174060",
            color: "#f4fbff",
            cursor: "pointer",
            fontWeight: 800,
          }}
        >
          Edit Vendor / Invoice
        </button>

        <button
          type="button"
          onClick={() => onDownload?.(row)}
          style={{
            padding: "12px 16px",
            borderRadius: 12,
            border: "1px solid rgba(110, 166, 214, 0.35)",
            background: "#1d6fa5",
            color: "#f4fbff",
            cursor: "pointer",
            fontWeight: 800,
          }}
        >
          Download This Page
        </button>
      </div>

      {row.detectedText ? (
        <div
          style={{
            marginTop: 14,
            borderRadius: 14,
            padding: 12,
            background: "#0d2233",
            border: "1px solid rgba(85, 140, 190, 0.2)",
          }}
        >
          <div style={{ color: "#d7eeff", fontWeight: 800, marginBottom: 8 }}>
            OCR Preview
          </div>
          <div
            style={{
              whiteSpace: "pre-wrap",
              maxHeight: 180,
              overflow: "auto",
              color: "#9fc3df",
              fontSize: 13,
              lineHeight: 1.5,
            }}
          >
            {row.detectedText}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function EditRowModal({
  isOpen,
  vendorName,
  invoiceNumber,
  onVendorChange,
  onInvoiceChange,
  onClose,
  onSave,
}) {
  if (!isOpen) return null;

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0, 0, 0, 0.6)",
        display: "grid",
        placeItems: "center",
        zIndex: 9999,
        padding: 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: 560,
          borderRadius: 20,
          padding: 20,
          background: "#0b1824",
          border: "1px solid rgba(85, 140, 190, 0.24)",
          boxShadow: "0 24px 70px rgba(0, 0, 0, 0.4)",
        }}
      >
        <div style={{ color: "#eef8ff", fontSize: 24, fontWeight: 900 }}>
          Edit Row
        </div>
        <div style={{ color: "#9fc3df", marginTop: 6, lineHeight: 1.6 }}>
          Update the vendor name or invoice number for this page.
        </div>

        <div style={{ marginTop: 18 }}>
          <label
            style={{
              display: "block",
              color: "#d7eeff",
              fontWeight: 800,
              marginBottom: 8,
            }}
          >
            Vendor
          </label>
          <input
            value={vendorName}
            onChange={(e) => onVendorChange(e.target.value)}
            placeholder="Enter vendor name"
            style={{
              width: "100%",
              boxSizing: "border-box",
              padding: "12px 14px",
              borderRadius: 12,
              border: "1px solid rgba(110, 166, 214, 0.35)",
              background: "#0f2232",
              color: "#eef8ff",
              outline: "none",
            }}
          />
        </div>

        <div style={{ marginTop: 16 }}>
          <label
            style={{
              display: "block",
              color: "#d7eeff",
              fontWeight: 800,
              marginBottom: 8,
            }}
          >
            Invoice Number
          </label>
          <input
            value={invoiceNumber}
            onChange={(e) => onInvoiceChange(e.target.value)}
            placeholder="Enter invoice number"
            style={{
              width: "100%",
              boxSizing: "border-box",
              padding: "12px 14px",
              borderRadius: 12,
              border: "1px solid rgba(110, 166, 214, 0.35)",
              background: "#0f2232",
              color: "#eef8ff",
              outline: "none",
            }}
          />
        </div>

        <div
          style={{
            marginTop: 16,
            borderRadius: 12,
            padding: 12,
            background: "#0d2233",
            border: "1px solid rgba(85, 140, 190, 0.2)",
          }}
        >
          <div style={{ color: "#d7eeff", fontWeight: 800, marginBottom: 6 }}>
            New Official File Name
          </div>
          <div style={{ color: "#cbe6fb", wordBreak: "break-word" }}>
            {makeOfficialFileName(vendorName, invoiceNumber)}
          </div>
        </div>

        <div
          style={{
            marginTop: 18,
            display: "flex",
            gap: 10,
            flexWrap: "wrap",
          }}
        >
          <button
            type="button"
            onClick={onSave}
            style={{
              padding: "12px 16px",
              borderRadius: 12,
              border: "1px solid rgba(110, 166, 214, 0.35)",
              background: "#1d6fa5",
              color: "#f4fbff",
              cursor: "pointer",
              fontWeight: 800,
            }}
          >
            Save Changes
          </button>

          <button
            type="button"
            onClick={onClose}
            style={{
              padding: "12px 16px",
              borderRadius: 12,
              border: "1px solid rgba(110, 166, 214, 0.35)",
              background: "#0f2538",
              color: "#e5f4ff",
              cursor: "pointer",
              fontWeight: 700,
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function VendorFieldTrainer({ items, onSave, onClose, saving }) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [mode, setMode] = useState("vendor");
  const [vendorName, setVendorName] = useState("");
  const [vendorBox, setVendorBox] = useState(null);
  const [invoiceBox, setInvoiceBox] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [draftRect, setDraftRect] = useState(null);
  const imageWrapRef = useRef(null);

  const current = items[currentIndex] || null;

  useEffect(() => {
    if (!current) return;
    setVendorName(current.suggestedVendorName || "");
    setVendorBox(current.vendorBox || null);
    setInvoiceBox(current.invoiceBox || null);
    setMode("vendor");
    setDragging(false);
    setDraftRect(null);
  }, [currentIndex, current]);

  useEffect(() => {
    if (currentIndex > Math.max(0, items.length - 1)) {
      setCurrentIndex(Math.max(0, items.length - 1));
    }
  }, [items.length, currentIndex]);

  function getRelativePoint(clientX, clientY) {
    const el = imageWrapRef.current;
    if (!el) return null;

    const bounds = el.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return null;

    return {
      x: clamp((clientX - bounds.left) / bounds.width, 0, 1),
      y: clamp((clientY - bounds.top) / bounds.height, 0, 1),
    };
  }

  function handlePointerDown(e) {
    if (!mode) return;
    const pt = getRelativePoint(e.clientX, e.clientY);
    if (!pt) return;

    setDragging(true);
    setDraftRect({
      x1: pt.x,
      y1: pt.y,
      x2: pt.x,
      y2: pt.y,
    });
  }

  function handlePointerMove(e) {
    if (!dragging) return;
    const pt = getRelativePoint(e.clientX, e.clientY);
    if (!pt) return;

    setDraftRect((prev) =>
      prev
        ? {
            ...prev,
            x2: pt.x,
            y2: pt.y,
          }
        : prev
    );
  }

  function handlePointerUp(e) {
    if (!dragging) return;

    const pt = getRelativePoint(e.clientX, e.clientY);
    const finalDraft =
      draftRect && pt
        ? {
            ...draftRect,
            x2: pt.x,
            y2: pt.y,
          }
        : draftRect;

    const rect = normalizeRect(finalDraft);

    setDragging(false);
    setDraftRect(null);

    if (!rect || rect.width < 0.01 || rect.height < 0.01) return;

    if (mode === "vendor") {
      setVendorBox(rect);
      setMode("invoice");
    } else if (mode === "invoice") {
      setInvoiceBox(rect);
      setMode(null);
    }
  }

  async function handleSaveCurrent() {
    if (!current) return;

    if (!vendorName.trim()) {
      window.alert("Enter the vendor name first.");
      return;
    }

    if (!vendorBox) {
      window.alert("Draw the Vendor Name box first.");
      return;
    }

    if (!invoiceBox) {
      window.alert("Draw the Invoice Number box first.");
      return;
    }

    await onSave({
      reviewId: current.reviewId,
      fileName: current.fileName,
      pageNumber: current.pageNumber,
      vendorName: vendorName.trim(),
      vendorBox,
      invoiceBox,
    });
  }

  if (!items?.length) return null;

  const vendorStyle = rectToCss(vendorBox);
  const invoiceStyle = rectToCss(invoiceBox);
  const draftStyle = rectToCss(normalizeRect(draftRect));

  return (
    <section
      style={{
        marginTop: 24,
        borderRadius: 20,
        padding: 20,
        border: "1px solid rgba(85, 140, 190, 0.24)",
        background: "rgba(10, 22, 34, 0.92)",
        boxShadow: "0 18px 50px rgba(0, 0, 0, 0.28)",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
          marginBottom: 16,
        }}
      >
        <div>
          <h2
            style={{
              margin: 0,
              fontSize: 22,
              color: "#e7f6ff",
            }}
          >
            New Vendor Review
          </h2>
          <div style={{ marginTop: 6, color: "#9fc3df" }}>
            Use the page preview below to mark exactly where the Vendor Name and
            Invoice Number appear.
          </div>
        </div>

        <button
          type="button"
          onClick={onClose}
          style={{
            border: "1px solid rgba(110, 166, 214, 0.35)",
            background: "#0d2335",
            color: "#e7f6ff",
            borderRadius: 12,
            padding: "10px 14px",
            cursor: "pointer",
            fontWeight: 700,
          }}
        >
          Close Review
        </button>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(320px, 1.25fr) minmax(280px, 0.75fr)",
          gap: 18,
        }}
      >
        <div>
          <div
            style={{
              display: "flex",
              gap: 10,
              flexWrap: "wrap",
              marginBottom: 12,
            }}
          >
            <button
              type="button"
              onClick={() => setMode("vendor")}
              style={{
                padding: "10px 14px",
                borderRadius: 10,
                border: "1px solid rgba(90, 214, 143, 0.4)",
                background: mode === "vendor" ? "#174e34" : "#0f2538",
                color: "#e5fff0",
                cursor: "pointer",
                fontWeight: 700,
              }}
            >
              Mark Vendor Name
            </button>

            <button
              type="button"
              onClick={() => setMode("invoice")}
              style={{
                padding: "10px 14px",
                borderRadius: 10,
                border: "1px solid rgba(93, 173, 226, 0.4)",
                background: mode === "invoice" ? "#174060" : "#0f2538",
                color: "#e5f4ff",
                cursor: "pointer",
                fontWeight: 700,
              }}
            >
              Mark Invoice Number
            </button>

            <button
              type="button"
              onClick={() => setVendorBox(null)}
              style={{
                padding: "10px 14px",
                borderRadius: 10,
                border: "1px solid rgba(110, 166, 214, 0.35)",
                background: "#0f2538",
                color: "#e5f4ff",
                cursor: "pointer",
              }}
            >
              Clear Vendor Box
            </button>

            <button
              type="button"
              onClick={() => setInvoiceBox(null)}
              style={{
                padding: "10px 14px",
                borderRadius: 10,
                border: "1px solid rgba(110, 166, 214, 0.35)",
                background: "#0f2538",
                color: "#e5f4ff",
                cursor: "pointer",
              }}
            >
              Clear Invoice Box
            </button>
          </div>

          <div
            ref={imageWrapRef}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerLeave={handlePointerUp}
            style={{
              position: "relative",
              width: "100%",
              minHeight: 420,
              borderRadius: 18,
              overflow: "hidden",
              border: "1px solid rgba(85, 140, 190, 0.28)",
              background: "#07131d",
              userSelect: "none",
              touchAction: "none",
              cursor:
                mode === "vendor" || mode === "invoice" ? "crosshair" : "default",
            }}
          >
            {current.previewUrl ? (
              <img
                src={current.previewUrl}
                alt={`Review page ${current.pageNumber}`}
                draggable={false}
                style={{
                  display: "block",
                  width: "100%",
                  height: "auto",
                }}
              />
            ) : (
              <div
                style={{
                  minHeight: 420,
                  display: "grid",
                  placeItems: "center",
                  padding: 24,
                  textAlign: "center",
                  color: "#9fc3df",
                }}
              >
                No page preview was returned by the backend for this page.
              </div>
            )}

            {vendorStyle && (
              <div
                style={{
                  position: "absolute",
                  ...vendorStyle,
                  border: "2px solid #5bd68d",
                  background: "rgba(91, 214, 141, 0.14)",
                  boxSizing: "border-box",
                }}
              >
                <div
                  style={{
                    position: "absolute",
                    top: -28,
                    left: 0,
                    background: "#5bd68d",
                    color: "#052113",
                    padding: "4px 8px",
                    borderRadius: 8,
                    fontWeight: 800,
                    fontSize: 12,
                  }}
                >
                  Vendor
                </div>
              </div>
            )}

            {invoiceStyle && (
              <div
                style={{
                  position: "absolute",
                  ...invoiceStyle,
                  border: "2px solid #5dade2",
                  background: "rgba(93, 173, 226, 0.14)",
                  boxSizing: "border-box",
                }}
              >
                <div
                  style={{
                    position: "absolute",
                    top: -28,
                    left: 0,
                    background: "#5dade2",
                    color: "#041d30",
                    padding: "4px 8px",
                    borderRadius: 8,
                    fontWeight: 800,
                    fontSize: 12,
                  }}
                >
                  Invoice #
                </div>
              </div>
            )}

            {draftStyle && (
              <div
                style={{
                  position: "absolute",
                  ...draftStyle,
                  border: "2px dashed #ffd166",
                  background: "rgba(255, 209, 102, 0.12)",
                  boxSizing: "border-box",
                }}
              />
            )}
          </div>
        </div>

        <div
          style={{
            borderRadius: 18,
            padding: 16,
            border: "1px solid rgba(85, 140, 190, 0.24)",
            background: "#0b1824",
          }}
        >
          <div style={{ marginBottom: 14 }}>
            <div style={{ color: "#d7eeff", fontWeight: 800, marginBottom: 6 }}>
              Review Item
            </div>
            <div style={{ color: "#9fc3df", lineHeight: 1.6, fontSize: 14 }}>
              File: <strong>{current.fileName || "Unknown file"}</strong>
              <br />
              Page: <strong>{current.pageNumber ?? "-"}</strong>
              <br />
              Queue: <strong>{currentIndex + 1}</strong> of{" "}
              <strong>{items.length}</strong>
            </div>
          </div>

          <label
            htmlFor="vendorName"
            style={{
              display: "block",
              marginBottom: 8,
              color: "#e7f6ff",
              fontWeight: 800,
            }}
          >
            Confirm Vendor Name
          </label>

          <input
            id="vendorName"
            value={vendorName}
            onChange={(e) => setVendorName(e.target.value)}
            placeholder="Enter vendor name"
            style={{
              width: "100%",
              boxSizing: "border-box",
              padding: "12px 14px",
              borderRadius: 12,
              border: "1px solid rgba(110, 166, 214, 0.35)",
              background: "#0f2232",
              color: "#eef8ff",
              outline: "none",
              marginBottom: 16,
            }}
          />

          <div
            style={{
              borderRadius: 14,
              padding: 12,
              background: "#0d2233",
              border: "1px solid rgba(85, 140, 190, 0.2)",
            }}
          >
            <div style={{ color: "#d7eeff", fontWeight: 800, marginBottom: 8 }}>
              Required Steps
            </div>
            <div style={{ color: "#9fc3df", fontSize: 14, lineHeight: 1.7 }}>
              1. Enter the vendor name.
              <br />
              2. Click <strong>Mark Vendor Name</strong> and drag a box.
              <br />
              3. Click <strong>Mark Invoice Number</strong> and drag a box.
              <br />
              4. Save the template.
            </div>
          </div>

          <div
            style={{
              marginTop: 14,
              borderRadius: 14,
              padding: 12,
              background: "#0d2233",
              border: "1px solid rgba(85, 140, 190, 0.2)",
            }}
          >
            <div style={{ color: "#d7eeff", fontWeight: 800, marginBottom: 8 }}>
              Status
            </div>
            <div
              style={{
                color: vendorBox ? "#98f0be" : "#ffd792",
                fontSize: 14,
                marginBottom: 4,
              }}
            >
              Vendor box: {vendorBox ? "set" : "missing"}
            </div>
            <div
              style={{
                color: invoiceBox ? "#8fd2ff" : "#ffd792",
                fontSize: 14,
              }}
            >
              Invoice box: {invoiceBox ? "set" : "missing"}
            </div>
          </div>

          {current.detectedText ? (
            <div
              style={{
                marginTop: 14,
                borderRadius: 14,
                padding: 12,
                background: "#0d2233",
                border: "1px solid rgba(85, 140, 190, 0.2)",
              }}
            >
              <div style={{ color: "#d7eeff", fontWeight: 800, marginBottom: 8 }}>
                OCR Preview
              </div>
              <div
                style={{
                  whiteSpace: "pre-wrap",
                  maxHeight: 160,
                  overflow: "auto",
                  color: "#9fc3df",
                  fontSize: 13,
                  lineHeight: 1.5,
                }}
              >
                {current.detectedText}
              </div>
            </div>
          ) : null}

          <div
            style={{
              display: "flex",
              gap: 10,
              flexWrap: "wrap",
              marginTop: 16,
            }}
          >
            <button
              type="button"
              onClick={handleSaveCurrent}
              disabled={saving}
              style={{
                padding: "12px 16px",
                borderRadius: 12,
                border: "1px solid rgba(110, 166, 214, 0.35)",
                background: saving ? "#31506a" : "#1d6fa5",
                color: "#f4fbff",
                cursor: saving ? "not-allowed" : "pointer",
                fontWeight: 800,
              }}
            >
              {saving ? "Saving..." : "Save Template"}
            </button>

            <button
              type="button"
              onClick={() => setCurrentIndex((prev) => Math.max(0, prev - 1))}
              disabled={currentIndex === 0}
              style={{
                padding: "12px 16px",
                borderRadius: 12,
                border: "1px solid rgba(110, 166, 214, 0.35)",
                background: "#0f2538",
                color: "#e5f4ff",
                cursor: currentIndex === 0 ? "not-allowed" : "pointer",
                opacity: currentIndex === 0 ? 0.55 : 1,
              }}
            >
              Previous
            </button>

            <button
              type="button"
              onClick={() =>
                setCurrentIndex((prev) => Math.min(items.length - 1, prev + 1))
              }
              disabled={currentIndex >= items.length - 1}
              style={{
                padding: "12px 16px",
                borderRadius: 12,
                border: "1px solid rgba(110, 166, 214, 0.35)",
                background: "#0f2538",
                color: "#e5f4ff",
                cursor:
                  currentIndex >= items.length - 1 ? "not-allowed" : "pointer",
                opacity: currentIndex >= items.length - 1 ? 0.55 : 1,
              }}
            >
              Next
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

export default function App() {
  const fileInputRef = useRef(null);

  const [booting, setBooting] = useState(true);
  const [bootError, setBootError] = useState("");
  const [serverReady, setServerReady] = useState(false);
  const [serverInfo, setServerInfo] = useState(null);

  const [selectedFile, setSelectedFile] = useState(null);
  const [dragActive, setDragActive] = useState(false);

  const [planning, setPlanning] = useState(false);
  const [reanalyzing, setReanalyzing] = useState(false);
  const [savingVendorTemplate, setSavingVendorTemplate] = useState(false);

  const [results, setResults] = useState([]);
  const [selectedResultIndex, setSelectedResultIndex] = useState(0);
  const [newVendorReviews, setNewVendorReviews] = useState([]);
  const [statusMessage, setStatusMessage] = useState("");

  const [editingRowIndex, setEditingRowIndex] = useState(null);
  const [editVendorName, setEditVendorName] = useState("");
  const [editInvoiceNumber, setEditInvoiceNumber] = useState("");

  const [progressVisible, setProgressVisible] = useState(false);
  const [progressPercent, setProgressPercent] = useState(0);
  const [progressLabel, setProgressLabel] = useState("");

  const progressTimerRef = useRef(null);
  const progressHideTimerRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    async function boot() {
      setBooting(true);
      setBootError("");

      const timeoutId = window.setTimeout(() => {
        controller.abort();
      }, 8000);

      try {
        const res = await fetch("/api/health", {
          method: "GET",
          signal: controller.signal,
        });

        window.clearTimeout(timeoutId);

        const data = await parseJsonSafe(res);

        if (!res.ok) {
          throw new Error(data?.error || `Health check failed: ${res.status}`);
        }

        if (!cancelled) {
          setServerReady(Boolean(data?.ok));
          setServerInfo(data || null);
        }
      } catch (err) {
        if (!cancelled) {
          setServerReady(false);
          setBootError(
            err?.name === "AbortError"
              ? "Backend did not respond in time."
              : err?.message || "Failed to reach backend."
          );
        }
      } finally {
        window.clearTimeout(timeoutId);
        if (!cancelled) {
          setBooting(false);
        }
      }
    }

    boot();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, []);

  useEffect(() => {
    if (selectedResultIndex > Math.max(0, results.length - 1)) {
      setSelectedResultIndex(Math.max(0, results.length - 1));
    }
  }, [results.length, selectedResultIndex]);

  useEffect(() => {
    return () => {
      clearProgressTimers();
    };
  }, []);

  const selectedResult = useMemo(() => {
    if (!results.length) return null;
    return results[selectedResultIndex] || results[0] || null;
  }, [results, selectedResultIndex]);

  const isEditModalOpen =
    editingRowIndex !== null &&
    editingRowIndex >= 0 &&
    editingRowIndex < results.length;

  function clearProgressTimers() {
    if (progressTimerRef.current) {
      window.clearInterval(progressTimerRef.current);
      progressTimerRef.current = null;
    }

    if (progressHideTimerRef.current) {
      window.clearTimeout(progressHideTimerRef.current);
      progressHideTimerRef.current = null;
    }
  }

  function beginProgress(label) {
    clearProgressTimers();
    setProgressVisible(true);
    setProgressPercent(0);
    setProgressLabel(label || "Starting...");
  }

  function startProcessingTail(label, floor = 72, cap = 95) {
    clearProgressTimers();
    setProgressVisible(true);
    setProgressLabel(label || "Processing...");
    setProgressPercent((prev) => Math.max(prev, floor));

    progressTimerRef.current = window.setInterval(() => {
      setProgressPercent((prev) => {
        if (prev >= cap) return prev;
        if (prev < 85) return prev + 2;
        return prev + 1;
      });
    }, 250);
  }

  function finishProgress(label) {
    clearProgressTimers();
    setProgressVisible(true);
    setProgressLabel(label || "Done");
    setProgressPercent(100);

    progressHideTimerRef.current = window.setTimeout(() => {
      setProgressVisible(false);
      setProgressPercent(0);
      setProgressLabel("");
    }, 700);
  }

  function handleChooseFile() {
    fileInputRef.current?.click();
  }

  function handleFiles(fileList) {
    const file = fileList?.[0] || null;
    setSelectedFile(file);
    setStatusMessage(file ? `Selected ${file.name}` : "");
  }

  function handleInputChange(e) {
    handleFiles(e.target.files);
  }

  function handleDragOver(e) {
    e.preventDefault();
    setDragActive(true);
  }

  function handleDragLeave(e) {
    e.preventDefault();
    setDragActive(false);
  }

  function handleDrop(e) {
    e.preventDefault();
    setDragActive(false);
    handleFiles(e.dataTransfer?.files);
  }

  function openEditModalByIndex(index) {
    const row = results[index];
    if (!row) return;

    setEditingRowIndex(index);
    setEditVendorName(row.vendorName || "");
    setEditInvoiceNumber(row.invoiceNumber || "");
  }

  function openEditModalForRow(row) {
    const index = results.findIndex(
      (item) => Number(item.pageNumber) === Number(row?.pageNumber)
    );
    if (index < 0) return;
    openEditModalByIndex(index);
  }

  function closeEditModal() {
    setEditingRowIndex(null);
    setEditVendorName("");
    setEditInvoiceNumber("");
  }

  function saveEditModal() {
    if (editingRowIndex === null) return;

    const vendorName = String(editVendorName || "").trim() || "UNKNOWN_VENDOR";
    const invoiceNumber = String(editInvoiceNumber || "").trim();
    const officialFileName = makeOfficialFileName(vendorName, invoiceNumber);

    setResults((prev) =>
      prev.map((item, index) => {
        if (index !== editingRowIndex) return item;

        return {
          ...item,
          vendorName,
          normalizedVendor: normalizeVendorNameForFile(vendorName),
          invoiceNumber,
          officialFileName,
        };
      })
    );

    setNewVendorReviews((prev) =>
      prev.map((item) => {
        const matchesPage =
          Number(item.pageNumber) === Number(results[editingRowIndex]?.pageNumber);

        if (!matchesPage) return item;

        return {
          ...item,
          suggestedVendorName: vendorName,
        };
      })
    );

    setStatusMessage(`Updated page ${results[editingRowIndex]?.pageNumber || ""}.`);
    closeEditModal();
  }

  async function handlePlan() {
    if (!selectedFile) {
      window.alert("Choose a PDF first.");
      return;
    }

    try {
      setPlanning(true);
      setStatusMessage("Uploading file and analyzing pages...");
      beginProgress("Uploading file...");

      const formData = new FormData();
      formData.append("file", selectedFile);

      const res = await postFormDataWithProgress("/api/plan", formData, {
        onUploadProgress: (uploadPercent) => {
          const mapped = Math.max(5, Math.min(70, Math.round(uploadPercent * 0.7)));
          setProgressVisible(true);
          setProgressLabel("Uploading file...");
          setProgressPercent(mapped);
        },
        onUploadComplete: () => {
          startProcessingTail("Processing pages...", 72, 95);
        },
      });

      const data = parseJsonTextSafe(res.text);

      if (!res.ok) {
        throw new Error(data?.error || `Plan request failed: ${res.status}`);
      }

      const nextResults = Array.isArray(data?.results) ? data.results : [];

      setResults(nextResults);
      setSelectedResultIndex(0);
      setNewVendorReviews(
        Array.isArray(data?.newVendorReviews) ? data.newVendorReviews : []
      );
      setStatusMessage(
        `Finished analyzing ${data?.totalPages || 0} page(s) from ${
          data?.fileName || selectedFile.name
        }. Click any row to preview that page.`
      );

      finishProgress("Analysis complete.");
    } catch (err) {
      console.error(err);
      clearProgressTimers();
      setProgressVisible(false);
      setProgressPercent(0);
      setProgressLabel("");
      setStatusMessage("");
      window.alert(err?.message || "Failed to process file.");
    } finally {
      setPlanning(false);
    }
  }

  async function reanalyzeCurrentFile(options = {}) {
    const keepPageNumber = options.keepPageNumber ?? null;

    if (!selectedFile) return;

    try {
      setReanalyzing(true);
      setStatusMessage("Re-evaluating PDF using the updated template collection...");
      beginProgress("Uploading PDF for re-evaluation...");

      const formData = new FormData();
      formData.append("file", selectedFile);

      const res = await postFormDataWithProgress("/api/plan", formData, {
        onUploadProgress: (uploadPercent) => {
          const mapped = Math.max(5, Math.min(70, Math.round(uploadPercent * 0.7)));
          setProgressVisible(true);
          setProgressLabel("Uploading PDF for re-evaluation...");
          setProgressPercent(mapped);
        },
        onUploadComplete: () => {
          startProcessingTail("Re-evaluating pages...", 72, 95);
        },
      });

      const data = parseJsonTextSafe(res.text);

      if (!res.ok) {
        throw new Error(data?.error || `Re-evaluation failed: ${res.status}`);
      }

      const nextResults = Array.isArray(data?.results) ? data.results : [];
      const nextReviews = Array.isArray(data?.newVendorReviews)
        ? data.newVendorReviews
        : [];

      setResults(nextResults);
      setNewVendorReviews(nextReviews);

      if (keepPageNumber != null && nextResults.length) {
        const nextIndex = nextResults.findIndex(
          (row) => Number(row.pageNumber) === Number(keepPageNumber)
        );
        setSelectedResultIndex(nextIndex >= 0 ? nextIndex : 0);
      } else {
        setSelectedResultIndex(0);
      }

      setStatusMessage(
        `Re-evaluation finished. ${nextResults.length} page(s) checked against the updated template collection.`
      );

      finishProgress("Re-evaluation complete.");
    } catch (err) {
      console.error(err);
      clearProgressTimers();
      setProgressVisible(false);
      setProgressPercent(0);
      setProgressLabel("");
      setStatusMessage("");
      window.alert(err?.message || "Failed to re-evaluate the PDF.");
    } finally {
      setReanalyzing(false);
    }
  }

  async function handleSaveVendorTemplate(payload) {
    try {
      setSavingVendorTemplate(true);

      const res = await fetch("/api/vendor-template", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      const data = await parseJsonSafe(res);

      if (!res.ok) {
        throw new Error(data?.error || "Failed to save vendor template.");
      }

      setStatusMessage(
        `Saved template for ${payload.vendorName}. Re-evaluating current PDF...`
      );

      await reanalyzeCurrentFile({
        keepPageNumber: payload.pageNumber,
      });
    } catch (err) {
      console.error(err);
      window.alert(err?.message || "Failed to save vendor template.");
    } finally {
      setSavingVendorTemplate(false);
    }
  }

  async function handleDownloadRow(row) {
    if (!selectedFile) {
      window.alert("Choose a PDF first.");
      return;
    }

    try {
      setStatusMessage(
        `Preparing ${row.officialFileName || "individual download"}...`
      );

      const formData = new FormData();
      formData.append("file", selectedFile);
      formData.append("pageNumber", String(row.pageNumber || ""));
      formData.append("vendorName", row.vendorName || "");
      formData.append("invoiceNumber", row.invoiceNumber || "");

      const res = await fetch("/api/download-page", {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        const data = await parseJsonSafe(res);
        throw new Error(
          data?.error || `Download request failed with status ${res.status}.`
        );
      }

      const blob = await res.blob();
      const disposition = res.headers.get("Content-Disposition");
      const downloadName =
        getFileNameFromDisposition(disposition) ||
        row.officialFileName ||
        "download.pdf";

      const url = window.URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = downloadName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.URL.revokeObjectURL(url);

      setStatusMessage(`Downloaded ${downloadName}.`);
    } catch (err) {
      console.error(err);
      setStatusMessage("");
      window.alert(err?.message || "Failed to download individual PDF.");
    }
  }

  function resetAll() {
    setSelectedFile(null);
    setResults([]);
    setSelectedResultIndex(0);
    setNewVendorReviews([]);
    setStatusMessage("");
    closeEditModal();
    clearProgressTimers();
    setProgressVisible(false);
    setProgressPercent(0);
    setProgressLabel("");
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  const pageCount = results.length;
  const newVendorCount = newVendorReviews.length;

  if (booting) {
    return (
      <div
        style={{
          minHeight: "100vh",
          background:
            "radial-gradient(circle at top, #12314a 0%, #08131d 55%, #050b12 100%)",
          color: "#e7f6ff",
          display: "grid",
          placeItems: "center",
          padding: 24,
          fontFamily:
            'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        }}
      >
        <div
          style={{
            width: "100%",
            maxWidth: 520,
            borderRadius: 22,
            padding: 28,
            background: "rgba(10, 22, 34, 0.88)",
            border: "1px solid rgba(90, 143, 191, 0.22)",
            boxShadow: "0 18px 50px rgba(0, 0, 0, 0.32)",
            textAlign: "center",
          }}
        >
          <div style={{ fontSize: 26, fontWeight: 900, marginBottom: 12 }}>
            Project Invoice
          </div>
          <div style={{ color: "#9fc3df", fontSize: 16 }}>
            Loading application...
          </div>
        </div>
      </div>
    );
  }

  if (bootError) {
    return (
      <div
        style={{
          minHeight: "100vh",
          background:
            "radial-gradient(circle at top, #12314a 0%, #08131d 55%, #050b12 100%)",
          color: "#e7f6ff",
          padding: 24,
          fontFamily:
            'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        }}
      >
        <div
          style={{
            maxWidth: 900,
            margin: "0 auto",
            borderRadius: 22,
            padding: 28,
            background: "rgba(10, 22, 34, 0.9)",
            border: "1px solid rgba(255, 107, 107, 0.22)",
            boxShadow: "0 18px 50px rgba(0, 0, 0, 0.32)",
          }}
        >
          <h1 style={{ marginTop: 0, marginBottom: 12 }}>App failed to start</h1>
          <div style={{ color: "#ffd6d6", marginBottom: 12 }}>{bootError}</div>
          <div style={{ color: "#9fc3df", lineHeight: 1.7 }}>
            Make sure your backend is running and that <strong>/api/health</strong>{" "}
            returns JSON.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        background:
          "radial-gradient(circle at top, #12314a 0%, #08131d 55%, #050b12 100%)",
        color: "#e7f6ff",
        padding: 24,
        fontFamily:
          'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      }}
    >
      <div style={{ maxWidth: 1450, margin: "0 auto" }}>
        <header
          style={{
            marginBottom: 24,
            borderRadius: 24,
            padding: 24,
            background: "rgba(10, 22, 34, 0.88)",
            border: "1px solid rgba(90, 143, 191, 0.22)",
            boxShadow: "0 18px 50px rgba(0, 0, 0, 0.28)",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: 14,
              alignItems: "flex-start",
              flexWrap: "wrap",
            }}
          >
            <div>
              <h1
                style={{
                  margin: 0,
                  fontSize: 34,
                  lineHeight: 1.1,
                  color: "#eef8ff",
                }}
              >
                Project Invoice
              </h1>
              <p
                style={{
                  margin: "10px 0 0",
                  color: "#9fc3df",
                  fontSize: 16,
                  lineHeight: 1.6,
                }}
              >
                Upload an invoice PDF, extract vendors and invoice numbers, inspect
                each page preview, train new templates, edit any row, and download
                each page as VENDOR_INVOICENUMBER.pdf.
              </p>
            </div>

            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <StatusPill tone={serverReady ? "success" : "warning"}>
                {serverReady ? "Backend Ready" : "Backend Not Ready"}
              </StatusPill>

              {pageCount > 0 ? (
                <StatusPill tone="info">{pageCount} page(s) analyzed</StatusPill>
              ) : null}

              {newVendorCount > 0 ? (
                <StatusPill tone="warning">
                  {newVendorCount} new vendor review item(s)
                </StatusPill>
              ) : null}
            </div>
          </div>
        </header>

        <section
          style={{
            borderRadius: 24,
            padding: 24,
            background: "rgba(10, 22, 34, 0.88)",
            border: "1px solid rgba(90, 143, 191, 0.22)",
            boxShadow: "0 18px 50px rgba(0, 0, 0, 0.28)",
          }}
        >
          <div
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            style={{
              borderRadius: 20,
              border: dragActive
                ? "2px solid rgba(122, 197, 255, 0.8)"
                : "2px dashed rgba(122, 197, 255, 0.35)",
              background: dragActive
                ? "rgba(35, 76, 113, 0.32)"
                : "rgba(9, 19, 29, 0.76)",
              padding: 28,
              textAlign: "center",
              transition: "all 0.15s ease",
            }}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,application/pdf"
              onChange={handleInputChange}
              style={{ display: "none" }}
            />

            <div
              style={{
                fontSize: 22,
                fontWeight: 900,
                color: "#eef8ff",
                marginBottom: 10,
              }}
            >
              Drag and drop your invoice PDF here
            </div>

            <div
              style={{
                color: "#cbe6fb",
                fontSize: 15,
                marginBottom: 16,
              }}
            >
              Or choose a file manually and analyze it.
            </div>

            <div
              style={{
                display: "flex",
                justifyContent: "center",
                gap: 12,
                flexWrap: "wrap",
              }}
            >
              <button
                type="button"
                onClick={handleChooseFile}
                disabled={planning || reanalyzing || savingVendorTemplate}
                style={{
                  padding: "12px 18px",
                  borderRadius: 12,
                  border: "1px solid rgba(110, 166, 214, 0.35)",
                  background: "#1d6fa5",
                  color: "#f4fbff",
                  cursor:
                    planning || reanalyzing || savingVendorTemplate
                      ? "not-allowed"
                      : "pointer",
                  fontWeight: 800,
                  opacity:
                    planning || reanalyzing || savingVendorTemplate ? 0.7 : 1,
                }}
              >
                Choose PDF
              </button>

              <button
                type="button"
                onClick={handlePlan}
                disabled={!selectedFile || planning || reanalyzing}
                style={{
                  padding: "12px 18px",
                  borderRadius: 12,
                  border: "1px solid rgba(110, 166, 214, 0.35)",
                  background:
                    !selectedFile || planning || reanalyzing
                      ? "#31506a"
                      : "#145884",
                  color: "#f4fbff",
                  cursor:
                    !selectedFile || planning || reanalyzing
                      ? "not-allowed"
                      : "pointer",
                  fontWeight: 800,
                }}
              >
                {planning
                  ? "Analyzing..."
                  : reanalyzing
                  ? "Re-evaluating..."
                  : "Analyze File"}
              </button>

              <button
                type="button"
                onClick={() => reanalyzeCurrentFile()}
                disabled={
                  !selectedFile || planning || reanalyzing || savingVendorTemplate
                }
                style={{
                  padding: "12px 18px",
                  borderRadius: 12,
                  border: "1px solid rgba(110, 166, 214, 0.35)",
                  background:
                    !selectedFile || planning || reanalyzing || savingVendorTemplate
                      ? "#31506a"
                      : "#174060",
                  color: "#f4fbff",
                  cursor:
                    !selectedFile || planning || reanalyzing || savingVendorTemplate
                      ? "not-allowed"
                      : "pointer",
                  fontWeight: 800,
                }}
              >
                {reanalyzing ? "Re-evaluating..." : "Re-evaluate PDF"}
              </button>

              <button
                type="button"
                onClick={resetAll}
                disabled={planning || reanalyzing || savingVendorTemplate}
                style={{
                  padding: "12px 18px",
                  borderRadius: 12,
                  border: "1px solid rgba(110, 166, 214, 0.35)",
                  background: "#0f2538",
                  color: "#e5f4ff",
                  cursor:
                    planning || reanalyzing || savingVendorTemplate
                      ? "not-allowed"
                      : "pointer",
                  fontWeight: 700,
                }}
              >
                Reset
              </button>
            </div>

            {selectedFile ? (
              <div
                style={{
                  marginTop: 16,
                  color: "#d7eeff",
                  fontWeight: 700,
                  lineHeight: 1.7,
                }}
              >
                Selected: {selectedFile.name} ({formatBytes(selectedFile.size)})
              </div>
            ) : (
              <div style={{ marginTop: 16, color: "#9fc3df" }}>
                No file selected yet.
              </div>
            )}

            {statusMessage ? (
              <div
                style={{
                  marginTop: 16,
                  color: "#d7eeff",
                  background: "rgba(79, 172, 254, 0.12)",
                  border: "1px solid rgba(79, 172, 254, 0.22)",
                  borderRadius: 12,
                  padding: "12px 14px",
                }}
              >
                {statusMessage}
              </div>
            ) : null}

            <ProgressBar
              visible={progressVisible}
              percent={progressPercent}
              label={progressLabel}
            />
          </div>
        </section>

        {results.length > 0 ? (
          <section
            style={{
              marginTop: 24,
              borderRadius: 24,
              padding: 24,
              background: "rgba(10, 22, 34, 0.88)",
              border: "1px solid rgba(90, 143, 191, 0.22)",
              boxShadow: "0 18px 50px rgba(0, 0, 0, 0.28)",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 12,
                flexWrap: "wrap",
                alignItems: "center",
                marginBottom: 16,
              }}
            >
              <div>
                <h2 style={{ margin: 0, fontSize: 24, color: "#eef8ff" }}>
                  Analysis Results
                </h2>
                <div style={{ marginTop: 6, color: "#9fc3df" }}>
                  Click any row to preview that page and inspect where the vendor
                  name and invoice number appear.
                </div>
              </div>
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(760px, 1fr) minmax(340px, 0.95fr)",
                gap: 18,
                alignItems: "start",
              }}
            >
              <div
                style={{
                  overflowX: "auto",
                  borderRadius: 18,
                  border: "1px solid rgba(85, 140, 190, 0.24)",
                }}
              >
                <table
                  style={{
                    width: "100%",
                    borderCollapse: "collapse",
                    minWidth: 1320,
                    background: "#09131d",
                  }}
                >
                  <thead>
                    <tr style={{ background: "#10273a" }}>
                      <th style={thStyle}>Preview</th>
                      <th style={thStyle}>Page</th>
                      <th style={thStyle}>Vendor</th>
                      <th style={thStyle}>Normalized Vendor</th>
                      <th style={thStyle}>Invoice Number</th>
                      <th style={thStyle}>Official File Name</th>
                      <th style={thStyle}>Template</th>
                      <th style={thStyle}>Match Score</th>
                      <th style={thStyle}>Edit</th>
                      <th style={thStyle}>Download</th>
                    </tr>
                  </thead>
                  <tbody>
                    {results.map((row, index) => {
                      const isSelected = index === selectedResultIndex;

                      return (
                        <tr
                          key={`${row.pageNumber}_${index}`}
                          onClick={() => setSelectedResultIndex(index)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              setSelectedResultIndex(index);
                            }
                          }}
                          role="button"
                          tabIndex={0}
                          aria-pressed={isSelected}
                          style={{
                            borderTop: "1px solid rgba(85, 140, 190, 0.14)",
                            cursor: "pointer",
                            background: isSelected
                              ? "rgba(32, 82, 121, 0.34)"
                              : "transparent",
                            outline: "none",
                          }}
                        >
                          <td style={tdStyle}>
                            {row.previewUrl ? (
                              <img
                                src={row.previewUrl}
                                alt={`Page ${row.pageNumber}`}
                                style={{
                                  width: 56,
                                  height: 72,
                                  objectFit: "cover",
                                  borderRadius: 8,
                                  display: "block",
                                  border: "1px solid rgba(110, 166, 214, 0.28)",
                                }}
                              />
                            ) : (
                              <div
                                style={{
                                  width: 56,
                                  height: 72,
                                  display: "grid",
                                  placeItems: "center",
                                  borderRadius: 8,
                                  border: "1px solid rgba(110, 166, 214, 0.18)",
                                  color: "#7da4c2",
                                  fontSize: 11,
                                  textAlign: "center",
                                  padding: 4,
                                }}
                              >
                                No preview
                              </div>
                            )}
                          </td>
                          <td style={tdStyle}>{row.pageNumber ?? "-"}</td>
                          <td style={tdStyle}>{row.vendorName || "-"}</td>
                          <td style={tdStyle}>{row.normalizedVendor || "-"}</td>
                          <td style={tdStyle}>{row.invoiceNumber || "-"}</td>
                          <td style={tdStyle}>
                            <span style={{ color: "#cbe6fb", wordBreak: "break-word" }}>
                              {row.officialFileName || "-"}
                            </span>
                          </td>
                          <td style={tdStyle}>
                            {row.hasSavedTemplate ? (
                              <span style={{ color: "#98f0be", fontWeight: 800 }}>
                                Yes
                              </span>
                            ) : (
                              <span style={{ color: "#ffd792", fontWeight: 800 }}>
                                No
                              </span>
                            )}
                          </td>
                          <td style={tdStyle}>{row.matchScore ?? 0}</td>
                          <td style={tdStyle}>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                openEditModalByIndex(index);
                              }}
                              style={{
                                padding: "10px 14px",
                                borderRadius: 10,
                                border: "1px solid rgba(110, 166, 214, 0.35)",
                                background: "#174060",
                                color: "#f4fbff",
                                cursor: "pointer",
                                fontWeight: 800,
                              }}
                            >
                              Edit
                            </button>
                          </td>
                          <td style={tdStyle}>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleDownloadRow(row);
                              }}
                              style={{
                                padding: "10px 14px",
                                borderRadius: 10,
                                border: "1px solid rgba(110, 166, 214, 0.35)",
                                background: "#1d6fa5",
                                color: "#f4fbff",
                                cursor: "pointer",
                                fontWeight: 800,
                              }}
                            >
                              Download
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <ResultPreviewPanel
                row={selectedResult}
                onDownload={handleDownloadRow}
                onEdit={openEditModalForRow}
              />
            </div>
          </section>
        ) : null}

        <VendorFieldTrainer
          items={newVendorReviews}
          saving={savingVendorTemplate}
          onSave={handleSaveVendorTemplate}
          onClose={() => setNewVendorReviews([])}
        />

        <EditRowModal
          isOpen={isEditModalOpen}
          vendorName={editVendorName}
          invoiceNumber={editInvoiceNumber}
          onVendorChange={setEditVendorName}
          onInvoiceChange={setEditInvoiceNumber}
          onClose={closeEditModal}
          onSave={saveEditModal}
        />

        <footer
          style={{
            marginTop: 24,
            borderRadius: 20,
            padding: 18,
            background: "rgba(10, 22, 34, 0.74)",
            border: "1px solid rgba(90, 143, 191, 0.18)",
            color: "#9fc3df",
            fontSize: 13,
            lineHeight: 1.7,
          }}
        >
          <div>
            Backend status:{" "}
            <strong style={{ color: "#e7f6ff" }}>
              {serverReady ? "connected" : "not connected"}
            </strong>
          </div>
          {serverInfo ? (
            <div>
              Health route responded successfully.
              {serverInfo.clientOrigin
                ? ` Allowed origin: ${serverInfo.clientOrigin}.`
                : ""}
            </div>
          ) : null}
        </footer>
      </div>
    </div>
  );
}

const thStyle = {
  textAlign: "left",
  padding: "14px 16px",
  color: "#d7eeff",
  fontSize: 13,
  letterSpacing: "0.02em",
};

const tdStyle = {
  padding: "14px 16px",
  color: "#cbe6fb",
  fontSize: 14,
  verticalAlign: "top",
};