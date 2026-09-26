import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    // 90 keeps the brand emblem's brushwork faithful when resized; 75 is the default.
    qualities: [75, 90],
  },
};

export default nextConfig;
