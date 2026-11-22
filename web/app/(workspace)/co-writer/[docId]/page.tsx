"use client";

import { useEffect } from "react";
import { useParams, useRouter } from "@/shared/router/navigation";

/**
 * Old Co-Writer document URLs now open the favorites notebooks library.
 * The rich-text page editor that used to live here has been removed.
 */
export default function CoWriterDocumentRedirectPage() {
  const router = useRouter();
  const params = useParams<{ docId?: string | string[] }>();
  useEffect(() => {
    router.replace("/notebooks", { scroll: false });
  }, [router, params.docId]);
  return <div className="min-h-48" aria-busy="true" />;
}
