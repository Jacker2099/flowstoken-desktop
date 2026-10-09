import { cn } from "@vetta-org/ui/utils";
import { Button } from "@vetta-org/ui/button";
import type { ComponentPropsWithoutRef } from "react";
import { forwardRef } from "react";
import { ProviderIcon } from "../shared/provider-icon";

interface ModelSelectorTriggerProps extends Omit<ComponentPropsWithoutRef<"button">, "children"> {
	readonly label: string;
	readonly icon?: string;
	readonly reasoningLabel?: string;
	readonly badge?: { readonly text: string; readonly tone: "primary" | "blue" | "amber" };
	readonly unavailable?: boolean;
	readonly unavailableBadge?: string;
	readonly unavailableHint?: string;
}

/** Shared input-bar model trigger; each picker keeps its own menu behavior. */
export const ModelSelectorTrigger = forwardRef<HTMLButtonElement, ModelSelectorTriggerProps>(
	function ModelSelectorTrigger(
		{
			label,
			icon,
			reasoningLabel,
			badge,
			unavailable,
			unavailableBadge,
			unavailableHint,
			className,
			title,
			...props
		},
		ref,
	) {
		return (
			<Button
				ref={ref}
				type="button"
				variant="ghost"
				size="xs"
				title={title ?? (unavailable && unavailableHint ? `${label}\n${unavailableHint}` : label)}
				aria-description={unavailable ? unavailableHint : undefined}
				className={cn(
					// The input bar is a CSS container: truncate the name before wrapping its toolbar.
					"flex min-w-0 max-w-[5.5rem] items-center gap-1 rounded-full border border-transparent px-1.5 py-0.5 text-[11px] text-foreground transition-colors focus:outline-none focus-visible:outline-none data-[state=open]:bg-accent/60 data-[state=open]:text-foreground @[22rem]:max-w-[9rem] @[28rem]:max-w-[13rem]",
					className,
				)}
				{...props}
			>
				{badge ? (
					<span
						className={cn(
							"max-w-8 shrink-0 truncate rounded px-1 @[22rem]:max-w-16 text-[10px] font-medium leading-[14px]",
							badge.tone === "primary" && "bg-primary/20 text-primary",
							badge.tone !== "primary" && "bg-muted text-muted-foreground",
						)}
						title={badge.text}
					>
						{badge.text}
					</span>
				) : (
					<ProviderIcon symbol={icon} className="h-3 w-3 shrink-0" />
				)}
				<span className="min-w-0 flex-1 truncate text-left">{label}</span>
				{unavailable ? (
					<span
						role="img"
						aria-label={unavailableBadge ?? unavailableHint ?? label}
						title={unavailableHint}
						className="icon-[solar--info-circle-linear] size-3 shrink-0 text-muted-foreground"
					/>
				) : null}
				{reasoningLabel ? (
					<span className="hidden shrink-0 rounded bg-muted/70 px-1 text-[9px] leading-[14px] text-muted-foreground @[28rem]:inline">
						{reasoningLabel}
					</span>
				) : null}
				<span aria-hidden="true" className="icon-[solar--alt-arrow-down-linear] h-2.5 w-2.5 shrink-0" />
			</Button>
		);
	},
);
