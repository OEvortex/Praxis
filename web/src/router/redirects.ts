import { createRoute, notFound, redirect } from "@tanstack/react-router";
import type { AnyRoute } from "@tanstack/react-router";

export function createRedirectRoutes<TRoot extends AnyRoute>(rootRoute: TRoot) {
  const indexRedirectRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    beforeLoad: () => {
      throw redirect({ to: "/chat" });
    },
  });

  const retiredPartnersGroupsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/partners/groups",
    beforeLoad: () => {
      throw notFound();
    },
  });

  const notebookLegacyIndexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/notebook",
    beforeLoad: ({ location }) => {
      throw redirect({ href: `/notebooks${location.searchStr}` });
    },
  });

  const notebookLegacySplatRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/notebook/$",
    beforeLoad: ({ params, location }) => {
      const splat = params._splat ? `/${params._splat}` : "";
      throw redirect({ href: `/notebooks${splat}${location.searchStr}` });
    },
  });

  const masteryStudyLegacyRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/mastery/$pathId/study",
    beforeLoad: ({ params, location }) => {
      throw redirect({
        href: `/learning/mastery/${params.pathId}/sessions${location.searchStr}`,
      });
    },
  });

  const masteryStudySessionLegacyRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/mastery/$pathId/study/$sessionId",
    beforeLoad: ({ params, location }) => {
      throw redirect({
        href: `/learning/mastery/${params.pathId}/sessions/${params.sessionId}${location.searchStr}`,
      });
    },
  });

  const legacyLearningSurfaceRoutes = (
    ["books", "mastery", "reading", "watching"] as const
  ).flatMap((surface) => [
    createRoute({
      getParentRoute: () => rootRoute,
      path: `/${surface}`,
      beforeLoad: ({ location }) => {
        throw redirect({ href: `/learning/${surface}${location.searchStr}` });
      },
    }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: `/${surface}/$`,
      beforeLoad: ({ params, location }) => {
        const splat = params._splat ? `/${params._splat}` : "";
        throw redirect({
          href: `/learning/${surface}${splat}${location.searchStr}`,
        });
      },
    }),
  ]);

  return [
    indexRedirectRoute,
    retiredPartnersGroupsRoute,
    notebookLegacyIndexRoute,
    notebookLegacySplatRoute,
    masteryStudyLegacyRoute,
    masteryStudySessionLegacyRoute,
    ...legacyLearningSurfaceRoutes,
  ];
}
