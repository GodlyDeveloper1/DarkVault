"use client";

// A QR code drawn here in the browser. Nothing is fetched to make it.
import { useEffect, useState } from "react";
import QRCode from "qrcode";

export default function Qr({ value, size = 180 }: { value: string; size?: number }) {
  const [svg, setSvg] = useState<string | null>(null);
  useEffect(() => {
    let stop = false;
    QRCode.toString(value, { type: "svg", margin: 1, errorCorrectionLevel: "M", color: { dark: "#000000", light: "#ffffff" } })
      .then((s) => !stop && setSvg(s))
      .catch(() => !stop && setSvg(null));
    return () => {
      stop = true;
    };
  }, [value]);
  return <div className="qr" style={{ width: size, height: size }} dangerouslySetInnerHTML={svg ? { __html: svg } : undefined} />;
}
