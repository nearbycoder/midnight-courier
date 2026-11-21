#pragma once

#include "CoreMinimal.h"

/** Player options: graphics, sound and gameplay. Stored in Saved/Courier/settings.ini; applied live. */
struct FMcSettings
{
	// Graphics
	int32 Quality = 2;            // 0 Low, 1 Medium, 2 High, 3 Ultra
	int32 ResScale = 0;           // 0 = Auto, else percent (50..100)
	int32 Display = 0;            // 0 Window, 1 Full screen
	bool bVSync = false;
	int32 FrameCap = 1;           // 0 = 60, 1 = 120, 2 = unlimited
	bool bLumen = true;
	bool bVolumetricFog = true;
	bool bMotionBlur = true;
	bool bShowFps = false;
	// Sound (0..10)
	int32 Master = 8, Music = 7, Effects = 8, Ambience = 7;
	// Gameplay
	int32 Shake = 10;             // 0..10
	bool bGhost = true;
	bool bHints = true;
	bool bRumble = true;

	static FMcSettings& Get();
	void Load();
	void Save() const;
	/** Pushes the graphics options to the engine (scalability, resolution, cvars). */
	void ApplyGraphics(UWorld* World, bool bDisplayChanged) const;

	float Volume(int32 Channel) const { return (Master / 10.f) * (Channel / 10.f); }
	static float AutoResScale(int32 Quality, int32 ScreenHeight);
	/** Re-evaluates the automatic resolution scale for the current viewport (call every so often). */
	void UpdateAutoScale(UWorld* World) const;
};

/** One row of the settings screen. */
struct FMcSettingRow
{
	FString Label;
	FString Section;              // non-empty on the first row of a section
	TFunction<FString()> Value;
	TFunction<void(int32)> Change; // -1 / +1; 0 = activate
	bool bAction = false;
};

TArray<FMcSettingRow> McBuildSettingsRows(UWorld* World, TFunction<void()> OnBack);
