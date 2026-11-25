import { WorktreeRunsPageView } from "./WorktreeRunsPageView";
import { useWorktreeRunsModel } from "./useWorktreeRunsModel";

export function WorktreeRunsPage() {
	const model = useWorktreeRunsModel();
	return <WorktreeRunsPageView model={model} />;
}
