/* eslint-disable react-refresh/only-export-components */
import { createLazyFileRoute, useNavigate, useParams } from "@tanstack/react-router";
import { IssuePanel } from "./-issue-panel";

export const Route = createLazyFileRoute("/_app/portal/issues/$issueId")({
  component: IssueFullscreenPage,
});

function IssueFullscreenPage() {
  const { issueId } = useParams({ from: "/_app/portal/issues/$issueId" });
  const navigate = useNavigate();
  const goBack = () => {
    void navigate({ to: "/portal/issues" });
  };
  return (
    <div className="h-full overflow-hidden">
      <IssuePanel issueId={issueId} variant="fullscreen" onClose={goBack} />
    </div>
  );
}
