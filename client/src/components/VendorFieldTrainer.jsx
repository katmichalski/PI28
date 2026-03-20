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

function percentRect(rect) {
  if (!rect) return null;
  return {
    left: `${rect.x * 100}%`,
    top: `${rect.y * 100}%`,
    width: `${rect.width * 100}%`,
    height: `${rect.height * 100}%`,
  };
}

export default function VendorFieldTrainer({
  items = [],
  onSave,
  onClose,
  saving = false,
}) {
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
    setDraftRect(null);
    setDragging(false);
  }, [currentIndex, current]);

  const vendorStyle = useMemo(() => percentRect(vendorBox), [vendorBox]);
  const invoiceStyle = useMemo(() => percentRect(invoiceBox), [invoiceBox]);
  const draftStyle = useMemo(
    () => percentRect(normalizeRect(draftRect)),
    [draftRect]
  );

  function getRelativePoint(clientX, clientY) {
    const el = imageWrapRef.current;
    if (!el) return null;

    const bounds = el.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return null;

    const x = clamp((clientX - bounds.left) / bounds.width, 0, 1);
    const y = clamp((clientY - bounds.top) / bounds.height, 0, 1);

    return { x, y };
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
      alert("Enter the vendor name before saving.");
      return;
    }
    if (!vendorBox) {
      alert("Draw the Vendor Name area before saving.");
      return;
    }
    if (!invoiceBox) {
      alert("Draw the Invoice Number area before saving.");
      return;
    }

    await onSave?.({
      reviewId: current.reviewId,
      fileName: current.fileName,
      pageNumber: current.pageNumber,
      vendorName: vendorName.trim(),
      vendorBox,
      invoiceBox,
    });

    if (currentIndex < items.length - 1) {
      setCurrentIndex((i) => i + 1);
    }
  }

  if (!items.length) return null;

  return (
    <section
      style={{
        marginTop: 24,
        padding: 20,
        border: "1px solid #2f4f6a",
        borderRadius: 16,
        background:
          "linear-gradient(180deg, rgba(8,18,30,0.95) 0%, rgba(9,24,40,0.95) 100%)",
        boxShadow: "0 12px 32px rgba(0,0,0,0.25)",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 16,
          alignItems: "center",
          marginBottom: 16,
          flexWrap: "wrap",
        }}
      >
        <div>
          <h2 style={{ margin: 0, color: "#cde9ff", fontSize: 22 }}>
            New Vendor Review
          </h2>
          <p style={{ margin: "6px 0 0", color: "#9fc3df" }}>
            Draw the location of the Vendor Name and Invoice Number so the app
            can learn this vendor layout.
          </p>
        </div>

        <button
          type="button"
          onClick={onClose}
          style={{
            border: "1px solid #4c7595",
            background: "#0d2234",
            color: "#d4ecff",
            borderRadius: 10,
            padding: "10px 14px",
            cursor: "pointer",
          }}
        >
          Close
        </button>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(320px, 1.2fr) minmax(280px, 0.8fr)",
          gap: 20,
        }}
      >
        <div>
          <div
            style={{
              marginBottom: 12,
              display: "flex",
              gap: 10,
              flexWrap: "wrap",
            }}
          >
            <button
              type="button"
              onClick={() => setMode("vendor")}
              style={{
                padding: "10px 14px",
                borderRadius: 10,
                border: "1px solid #4d7ea5",
                background: mode === "vendor" ? "#15507a" : "#0f2538",
                color: "#e5f4ff",
                cursor: "pointer",
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
                border: "1px solid #4d7ea5",
                background: mode === "invoice" ? "#15507a" : "#0f2538",
                color: "#e5f4ff",
                cursor: "pointer",
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
                border: "1px solid #4d7ea5",
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
                border: "1px solid #4d7ea5",
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
              border: "1px solid #355979",
              borderRadius: 16,
              overflow: "hidden",
              background: "#09131d",
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
                style={{
                  display: "block",
                  width: "100%",
                  height: "auto",
                }}
                draggable={false}
              />
            ) : (
              <div
                style={{
                  minHeight: 420,
                  display: "grid",
                  placeItems: "center",
                  color: "#9ebdd8",
                  padding: 20,
                  textAlign: "center",
                }}
              >
                No page preview available. Return a preview image URL from the
                backend for this review item.
              </div>
            )}

            {vendorStyle && (
              <div
                style={{
                  position: "absolute",
                  ...vendorStyle,
                  border: "2px solid #58d68d",
                  background: "rgba(88,214,141,0.14)",
                  boxSizing: "border-box",
                }}
              >
                <div
                  style={{
                    position: "absolute",
                    top: -28,
                    left: 0,
                    background: "#58d68d",
                    color: "#062312",
                    fontSize: 12,
                    fontWeight: 700,
                    padding: "4px 8px",
                    borderRadius: 8,
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
                  background: "rgba(93,173,226,0.14)",
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
                    fontSize: 12,
                    fontWeight: 700,
                    padding: "4px 8px",
                    borderRadius: 8,
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
                  background: "rgba(255,209,102,0.12)",
                  boxSizing: "border-box",
                }}
              />
            )}
          </div>
        </div>

        <div
          style={{
            border: "1px solid #355979",
            borderRadius: 16,
            padding: 16,
            background: "#0b1824",
          }}
        >
          <div style={{ marginBottom: 14 }}>
            <div style={{ color: "#d4ecff", fontWeight: 700, marginBottom: 6 }}>
              Review Item
            </div>
            <div style={{ color: "#9fc3df", fontSize: 14, lineHeight: 1.5 }}>
              File: <strong>{current.fileName || "Unknown file"}</strong>
              <br />
              Page: <strong>{current.pageNumber ?? "-"}</strong>
              <br />
              Queue: <strong>{currentIndex + 1}</strong> of{" "}
              <strong>{items.length}</strong>
            </div>
          </div>

          <label
            htmlFor="new-vendor-name"
            style={{
              display: "block",
              color: "#d4ecff",
              fontWeight: 700,
              marginBottom: 8,
            }}
          >
            Confirm Vendor Name
          </label>
          <input
            id="new-vendor-name"
            value={vendorName}
            onChange={(e) => setVendorName(e.target.value)}
            placeholder="Enter normalized vendor name"
            style={{
              width: "100%",
              padding: "12px 14px",
              borderRadius: 10,
              border: "1px solid #456a87",
              background: "#0f2232",
              color: "#eef8ff",
              outline: "none",
              marginBottom: 16,
              boxSizing: "border-box",
            }}
          />

          <div
            style={{
              marginBottom: 12,
              color: "#d4ecff",
              fontWeight: 700,
            }}
          >
            Required Steps
          </div>

          <div style={{ color: "#9fc3df", fontSize: 14, lineHeight: 1.65 }}>
            <div>1. Enter the vendor name.</div>
            <div>2. Click “Mark Vendor Name” and drag a box over the vendor.</div>
            <div>
              3. Click “Mark Invoice Number” and drag a box over the invoice
              number.
            </div>
            <div>4. Save this template.</div>
          </div>

          <div
            style={{
              marginTop: 16,
              padding: 12,
              borderRadius: 12,
              background: "#0e2435",
              border: "1px solid #294761",
            }}
          >
            <div style={{ color: "#d4ecff", fontWeight: 700, marginBottom: 8 }}>
              Status
            </div>
            <div style={{ color: vendorBox ? "#8ff0b7" : "#ffcf8b", fontSize: 14 }}>
              Vendor box: {vendorBox ? "set" : "missing"}
            </div>
            <div
              style={{
                color: invoiceBox ? "#8fd2ff" : "#ffcf8b",
                fontSize: 14,
                marginTop: 4,
              }}
            >
              Invoice box: {invoiceBox ? "set" : "missing"}
            </div>
          </div>

          {current.detectedText && (
            <div
              style={{
                marginTop: 16,
                padding: 12,
                borderRadius: 12,
                background: "#0e2435",
                border: "1px solid #294761",
              }}
            >
              <div style={{ color: "#d4ecff", fontWeight: 700, marginBottom: 8 }}>
                OCR Preview
              </div>
              <div
                style={{
                  color: "#9fc3df",
                  fontSize: 13,
                  maxHeight: 160,
                  overflow: "auto",
                  whiteSpace: "pre-wrap",
                }}
              >
                {current.detectedText}
              </div>
            </div>
          )}

          <div
            style={{
              display: "flex",
              gap: 10,
              marginTop: 18,
              flexWrap: "wrap",
            }}
          >
            <button
              type="button"
              onClick={handleSaveCurrent}
              disabled={saving}
              style={{
                padding: "12px 16px",
                borderRadius: 10,
                border: "1px solid #5a93bb",
                background: saving ? "#31506a" : "#1d6fa5",
                color: "#f4fbff",
                cursor: saving ? "not-allowed" : "pointer",
                fontWeight: 700,
              }}
            >
              {saving ? "Saving..." : "Save Template"}
            </button>

            <button
              type="button"
              disabled={currentIndex === 0}
              onClick={() => setCurrentIndex((i) => Math.max(0, i - 1))}
              style={{
                padding: "12px 16px",
                borderRadius: 10,
                border: "1px solid #4d7ea5",
                background: "#0f2538",
                color: "#e5f4ff",
                cursor: currentIndex === 0 ? "not-allowed" : "pointer",
              }}
            >
              Previous
            </button>

            <button
              type="button"
              disabled={currentIndex >= items.length - 1}
              onClick={() =>
                setCurrentIndex((i) => Math.min(items.length - 1, i + 1))
              }
              style={{
                padding: "12px 16px",
                borderRadius: 10,
                border: "1px solid #4d7ea5",
                background: "#0f2538",
                color: "#e5f4ff",
                cursor: currentIndex >= items.length - 1 ? "not-allowed" : "pointer",
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