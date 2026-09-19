import { FlowstokenAccountSettingsView } from "./FlowstokenAccountSettingsView";
import { useFlowstokenAccountSettingsModel } from "./useFlowstokenAccountSettingsModel";

export function FlowstokenAccountSettings(): JSX.Element {
	return <FlowstokenAccountSettingsView model={useFlowstokenAccountSettingsModel()} />;
}
