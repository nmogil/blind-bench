import { lazy, Suspense } from "react";
import { Routes, Route, Navigate, Outlet } from "react-router-dom";
import { Authenticated, Unauthenticated, AuthLoading } from "convex/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { RootRedirect } from "@/components/RootRedirect";
import { OrgLayout } from "@/components/layouts/OrgLayout";
import { ProjectLayout } from "@/components/layouts/ProjectLayout";
import { EvalLayout } from "@/components/layouts/EvalLayout";
import { GlobalErrorBoundary } from "@/components/GlobalErrorBoundary";
import { PostHogIdentityBridge } from "@/components/PostHogIdentityBridge";
import { Skeleton } from "@/components/ui/skeleton";

// Route-level code splitting — each route loads its own chunk on demand
const SignIn = lazy(() => import("./routes/auth/SignIn").then(m => ({ default: m.SignIn })));
const Onboarding = lazy(() => import("./routes/Onboarding").then(m => ({ default: m.Onboarding })));
const OrgHome = lazy(() => import("./routes/orgs/OrgHome").then(m => ({ default: m.OrgHome })));
const OrgSettings = lazy(() => import("./routes/orgs/settings/OrgSettings").then(m => ({ default: m.OrgSettings })));
const OrgMembers = lazy(() => import("./routes/orgs/settings/OrgMembers").then(m => ({ default: m.OrgMembers })));
const OpenRouterKey = lazy(() => import("./routes/orgs/settings/OpenRouterKey").then(m => ({ default: m.OpenRouterKey })));
const ProjectSettings = lazy(() => import("./routes/orgs/projects/settings/ProjectSettings").then(m => ({ default: m.ProjectSettings })));
const ProjectCollaborators = lazy(() => import("./routes/orgs/projects/settings/ProjectCollaborators").then(m => ({ default: m.ProjectCollaborators })));
const Variables = lazy(() => import("./routes/orgs/projects/Variables").then(m => ({ default: m.Variables })));
const TestCases = lazy(() => import("./routes/orgs/projects/TestCases").then(m => ({ default: m.TestCases })));
const TestCaseEditor = lazy(() => import("./routes/orgs/projects/TestCaseEditor").then(m => ({ default: m.TestCaseEditor })));
const Versions = lazy(() => import("./routes/orgs/projects/Versions").then(m => ({ default: m.Versions })));
const VersionEditor = lazy(() => import("./routes/orgs/projects/VersionEditor").then(m => ({ default: m.VersionEditor })));
const RunView = lazy(() => import("./routes/orgs/projects/RunView").then(m => ({ default: m.RunView })));
const RunsList = lazy(() => import("./routes/orgs/projects/RunsList").then(m => ({ default: m.RunsList })));
const OptimizationReview = lazy(() => import("./routes/orgs/projects/OptimizationReview").then(m => ({ default: m.OptimizationReview })));
const NotFound = lazy(() => import("./routes/errors/NotFound").then(m => ({ default: m.NotFound })));
const Denied = lazy(() => import("./routes/errors/Denied").then(m => ({ default: m.Denied })));
const QuickCompare = lazy(() => import("./routes/compare/QuickCompare").then(m => ({ default: m.QuickCompare })));
const ReviewDemo = lazy(() => import("./routes/review/DemoDeck").then(m => ({ default: m.DemoDeck })));
const SessionDeck = lazy(() => import("./routes/review/SessionDeck").then(m => ({ default: m.SessionDeck })));
const ReviewRunStarter = lazy(() => import("./routes/review/ReviewStarter").then(m => ({ default: m.ReviewRunStarter })));
const ReviewCycleStarter = lazy(() => import("./routes/review/ReviewStarter").then(m => ({ default: m.ReviewCycleStarter })));
const TokenReviewCycleStarter = lazy(() => import("./routes/review/ReviewStarter").then(m => ({ default: m.TokenReviewCycleStarter })));
const CycleShareableEvalView = lazy(() => import("./routes/share/CycleShareableEvalView").then(m => ({ default: m.CycleShareableEvalView })));
const InviteLanding = lazy(() => import("./routes/invite/InviteLanding").then(m => ({ default: m.InviteLanding })));
const InvitesInbox = lazy(() => import("./routes/invite/InvitesInbox").then(m => ({ default: m.InvitesInbox })));
const RunConfigurator = lazy(() => import("./routes/orgs/projects/RunConfigurator").then(m => ({ default: m.RunConfigurator })));
const CyclesList = lazy(() => import("./routes/orgs/projects/cycles/CyclesList").then(m => ({ default: m.CyclesList })));
const CycleCreator = lazy(() => import("./routes/orgs/projects/cycles/CycleCreator").then(m => ({ default: m.CycleCreator })));
const CycleDetail = lazy(() => import("./routes/orgs/projects/cycles/CycleDetail").then(m => ({ default: m.CycleDetail })));
const VersionDashboard = lazy(() => import("./routes/orgs/projects/cycles/VersionDashboard").then(m => ({ default: m.VersionDashboard })));
const EvaluatePage = lazy(() => import("./routes/orgs/projects/EvaluatePage").then(m => ({ default: m.EvaluatePage })));
const HistoryPage = lazy(() => import("./routes/orgs/projects/HistoryPage").then(m => ({ default: m.HistoryPage })));
const Terms = lazy(() => import("./routes/legal/Terms").then(m => ({ default: m.Terms })));
const Privacy = lazy(() => import("./routes/legal/Privacy").then(m => ({ default: m.Privacy })));

export function App() {
  return (
    <GlobalErrorBoundary>
    <TooltipProvider>
      <PostHogIdentityBridge />
      <Suspense fallback={<LoadingScreen />}>
      <Routes>
        <Route path="/auth/sign-in" element={<AuthGatePublic />} />
        <Route path="/compare" element={<QuickCompare />} />
        <Route path="/review/demo" element={<ReviewDemo />} />
        <Route path="/s/cycle/:token" element={<CycleShareableEvalView />} />
        <Route path="/invite/:token" element={<InviteLanding />} />
        <Route path="/legal/terms" element={<Terms />} />
        <Route path="/legal/privacy" element={<Privacy />} />
        <Route element={<AuthGateProtected />}>
          <Route path="/" element={<RootRedirect />} />
          <Route path="/onboarding" element={<Onboarding />} />
          <Route path="/review/session/:sessionId" element={<SessionDeck />} />
          <Route path="/review/start/run/:runId" element={<ReviewRunStarter />} />
          <Route path="/review/start/cycle/:cycleId" element={<ReviewCycleStarter />} />
          <Route path="/orgs/:orgSlug" element={<OrgLayout />}>
            <Route index element={<OrgHome />} />
            <Route path="settings" element={<OrgSettings />} />
            <Route path="settings/members" element={<OrgMembers />} />
            <Route path="settings/openrouter-key" element={<OpenRouterKey />} />
            <Route path="projects/:projectId" element={<ProjectLayout />}>
              <Route index element={<Navigate to="versions" replace />} />
              <Route path="variables" element={<Variables />} />
              <Route path="test-cases" element={<TestCases />} />
              <Route
                path="test-cases/:testCaseId"
                element={<TestCaseEditor />}
              />
              <Route path="versions" element={<Versions />} />
              <Route
                path="versions/:versionId"
                element={<VersionEditor />}
              />
              <Route
                path="versions/:versionId/dashboard"
                element={<VersionDashboard />}
              />
              <Route path="run" element={<RunConfigurator />} />
              <Route path="runs" element={<RunsList />} />
              <Route path="runs/:runId" element={<RunView />} />
              <Route
                path="optimizations/:requestId"
                element={<OptimizationReview />}
              />
              <Route path="cycles" element={<CyclesList />} />
              <Route path="cycles/new" element={<CycleCreator />} />
              <Route
                path="cycles/:cycleId"
                element={<CycleDetail />}
              />
              <Route path="evaluate" element={<EvaluatePage />} />
              <Route path="history" element={<HistoryPage />} />
              <Route path="settings" element={<ProjectSettings />} />
              <Route
                path="settings/collaborators"
                element={<ProjectCollaborators />}
              />
            </Route>
          </Route>
          <Route path="/eval" element={<EvalLayout />}>
            <Route index element={<InvitesInbox />} />
            <Route
              path="cycle/:cycleEvalToken"
              element={<TokenReviewCycleStarter />}
            />
          </Route>
          <Route path="/denied" element={<Denied />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
      </Suspense>
      <Toaster />
    </TooltipProvider>
    </GlobalErrorBoundary>
  );
}

function AuthGatePublic() {
  return (
    <>
      <Authenticated>
        <Navigate to="/" replace />
      </Authenticated>
      <Unauthenticated>
        <SignIn />
      </Unauthenticated>
      <AuthLoading>
        <LoadingScreen />
      </AuthLoading>
    </>
  );
}

function AuthGateProtected() {
  return (
    <>
      <Authenticated>
        <Outlet />
      </Authenticated>
      <Unauthenticated>
        <Navigate to="/auth/sign-in" replace />
      </Unauthenticated>
      <AuthLoading>
        <LoadingScreen />
      </AuthLoading>
    </>
  );
}

function LoadingScreen() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <Skeleton className="h-8 w-48" />
    </div>
  );
}
