"use client";

import { useState } from "react";
import Image from "next/image";

/**
 * Token logo from stored CoinGecko metadata. Decorative only (identity is the
 * canonical token), so it has empty alt text; a missing or failed image falls
 * back to a monogram and never shows a broken-image icon.
 *
 * No `referrerPolicy` is set: CoinGecko's image CDN can reject or otherwise
 * mishandle requests with a stripped Referer, which showed up as some
 * validated logos (e.g. Immutable/IMX) silently falling back to the
 * monogram despite a correct, validated URL. The default referrer policy
 * sends only the origin on a cross-origin request, which is enough for the
 * CDN and leaks nothing beyond this site's domain.
 */
export function TokenLogo({ src, symbol, size = 28 }: { src: string | null | undefined; symbol: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  const style = { width: size, height: size, fontSize: Math.round(size * 0.4) };
  if (!src || failed) {
    return <span className="token-logo token-logo-fallback" style={style} aria-hidden="true">{symbol.slice(0, 1)}</span>;
  }
  return (
    <span className="token-logo" style={style} aria-hidden="true">
      <Image
        src={src}
        alt=""
        width={size}
        height={size}
        unoptimized
        loading="lazy"
        onError={() => setFailed(true)}
        // An image that failed before hydration never fires onError in React; detect it on mount.
        ref={(image) => {
          if (image && image.complete && image.naturalWidth === 0) setFailed(true);
        }}
      />
    </span>
  );
}
