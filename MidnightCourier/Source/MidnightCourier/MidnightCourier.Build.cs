using UnrealBuildTool;

public class MidnightCourier : ModuleRules
{
	public MidnightCourier(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
		PublicDependencyModuleNames.AddRange(new string[] { "Core", "CoreUObject", "Engine", "InputCore", "Slate", "SlateCore", "Json", "RenderCore", "RHI", "ApplicationCore", "AudioMixer" });
	}
}
