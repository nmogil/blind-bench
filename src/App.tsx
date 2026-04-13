import { Routes, Route, Navigate, Outlet } from "react-router-dom";
import { Authenticated, Unauthenticated, AuthLoading } from "convex/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { SignIn } from "./routes/auth/SignIn";
import { RootRedirect } from "@/components/RootRedirect";
import { OrgLayout } from "@/components/layouts/OrgLayout";
import { ProjectLayout } from "@/components/layouts/ProjectLayout";
import { EvalLayout } from "@/components/layouts/EvalLayout";
import { Onboarding } from "./routes/Onboarding";
import { OrgHome } from "./routes/orgs/OrgHome";
import { OrgSettings } from "./routes/orgs/settings/OrgSettings";
import { OrgMembers } from "./routes/orgs/settings/OrgMembers";
import { OpenRouterKey } from "./routes/orgs/settings/OpenRouterKey";
import { ProjectHome } from "./routes/orgs/projects/ProjectHome";
import { ProjectSettings } from "./routes/orgs/projects/settings/ProjectSettings";
import { ProjectCollaborators } from "./routes/orgs/projects/settings/ProjectCollaborators";
import { Variables } from "./routes/orgs/projects/Variables";
import { TestCases } from "./routes/orgs/projects/TestCases";
import { TestCaseEditor } from "./routes/orgs/projects/TestCaseEditor";
import { Versions } from "./routes/orgs/projects/Versions";
import { VersionEditor } from "./routes/orgs/projects/VersionEditor";
import { MetaContext } from "./routes/orgs/projects/MetaContext";
import { RunView } from "./routes/orgs/projects/RunView";
import { RunsList } from "./routes/orgs/projects/RunsList";
import { OptimizationReview } from "./routes/orgs/projects/OptimizationReview";
import { CompareView } from "./routes/orgs/projects/CompareView";
import { EvalInbox } from "./routes/eval/EvalInbox";
import { BlindEvalView } from "./routes/eval/BlindEvalView";
import { NotFound } from "./routes/errors/NotFound";
import { Denied } from "./routes/errors/Denied";
import { Skeleton } from "@/components/ui/skeleton";

export function App() {
  return (
    <TooltipProvider>
      <Routes>
        <Route path="/auth/sign-in" element={<AuthGatePublic />} />
        <Route element={<AuthGateProtected />}>
          <Route path="/" element={<RootRedirect />} />
          <Route path="/onboarding" element={<Onboarding />} />
          <Route path="/orgs/:orgSlug" element={<OrgLayout />}>
            <Route index element={<OrgHome />} />
            <Route path="settings" element={<OrgSettings />} />
            <Route path="settings/members" element={<OrgMembers />} />
            <Route path="settings/openrouter-key" element={<OpenRouterKey />} />
            <Route path="projects/:projectId" element={<ProjectLayout />}>
              <Route index element={<ProjectHome />} />
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
              <Route path="runs" element={<RunsList />} />
              <Route path="runs/:runId" element={<RunView />} />
              <Route
                path="optimizations/:requestId"
                element={<OptimizationReview />}
              />
              <Route path="compare" element={<CompareView />} />
              <Route path="meta-context" element={<MetaContext />} />
              <Route path="settings" element={<ProjectSettings />} />
              <Route
                path="settings/collaborators"
                element={<ProjectCollaborators />}
              />
            </Route>
          </Route>
          <Route path="/eval" element={<EvalLayout />}>
            <Route index element={<EvalInbox />} />
            <Route path=":opaqueRunToken" element={<BlindEvalView />} />
          </Route>
          <Route path="/denied" element={<Denied />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
      <Toaster />
    </TooltipProvider>
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
