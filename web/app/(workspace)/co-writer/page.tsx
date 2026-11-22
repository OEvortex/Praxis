"use client";

import { useEffect } from "react";
import { useRouter } from "@/shared/router/navigation";

/**
 * The Co-Writer page editor has been retired in favour of DeepTutor-style
 * favorites notebooks. Keep the old URL working as a redirect so bookmarks
 * and in-app links do not dead-end.
 */
export default function CoWriterRedirectPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/notebooks", { scroll: false });
  }, [router]);
  return <div className="min-h-48" aria-busy="true" />;
}
