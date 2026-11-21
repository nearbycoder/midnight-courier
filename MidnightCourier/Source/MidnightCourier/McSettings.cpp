#include "McSettings.h"

#include "Engine/Engine.h"
#include "Engine/GameViewportClient.h"
#include "Engine/World.h"
#include "GameFramework/GameUserSettings.h"
#include "HAL/IConsoleManager.h"
#include "HAL/PlatformApplicationMisc.h"
#include "Misc/ConfigCacheIni.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "McTypes.h"

namespace
{
	FString SettingsPath() { return FPaths::ProjectSavedDir() / TEXT("Courier/settings.ini"); }

	void SetCVar(const TCHAR* Name, int32 Value)
	{
		if (IConsoleVariable* V = IConsoleManager::Get().FindConsoleVariable(Name)) { V->Set(Value, ECVF_SetByCode); }
	}
	void SetCVarF(const TCHAR* Name, float Value)
	{
		if (IConsoleVariable* V = IConsoleManager::Get().FindConsoleVariable(Name)) { V->Set(Value, ECVF_SetByCode); }
	}
	const TCHAR* OnOff(bool b) { return b ? TEXT("ON") : TEXT("OFF"); }
}

FMcSettings& FMcSettings::Get()
{
	static FMcSettings S;
	static bool bLoaded = false;
	if (!bLoaded) { bLoaded = true; S.Load(); }
	return S;
}

void FMcSettings::Load()
{
	FString Text;
	if (!FFileHelper::LoadFileToString(Text, *SettingsPath())) { return; }
	TArray<FString> Lines;
	Text.ParseIntoArrayLines(Lines);
	for (const FString& L : Lines)
	{
		FString K, V;
		if (!L.Split(TEXT("="), &K, &V)) { continue; }
		const int32 I = FCString::Atoi(*V);
		if (K == TEXT("Quality")) Quality = FMath::Clamp(I, 0, 3);
		else if (K == TEXT("ResScale")) ResScale = FMath::Clamp(I, 0, 100);
		else if (K == TEXT("Display")) Display = FMath::Clamp(I, 0, 1);
		else if (K == TEXT("VSync")) bVSync = I != 0;
		else if (K == TEXT("FrameCap")) FrameCap = FMath::Clamp(I, 0, 2);
		else if (K == TEXT("Lumen")) bLumen = I != 0;
		else if (K == TEXT("VolumetricFog")) bVolumetricFog = I != 0;
		else if (K == TEXT("MotionBlur")) bMotionBlur = I != 0;
		else if (K == TEXT("ShowFps")) bShowFps = I != 0;
		else if (K == TEXT("Master")) Master = FMath::Clamp(I, 0, 10);
		else if (K == TEXT("Music")) Music = FMath::Clamp(I, 0, 10);
		else if (K == TEXT("Effects")) Effects = FMath::Clamp(I, 0, 10);
		else if (K == TEXT("Ambience")) Ambience = FMath::Clamp(I, 0, 10);
		else if (K == TEXT("Shake")) Shake = FMath::Clamp(I, 0, 10);
		else if (K == TEXT("Ghost")) bGhost = I != 0;
		else if (K == TEXT("Hints")) bHints = I != 0;
		else if (K == TEXT("Rumble")) bRumble = I != 0;
	}
}

void FMcSettings::Save() const
{
	FString T;
	T += FString::Printf(TEXT("Quality=%d\nResScale=%d\nDisplay=%d\nVSync=%d\nFrameCap=%d\nLumen=%d\nVolumetricFog=%d\nMotionBlur=%d\nShowFps=%d\n"),
		Quality, ResScale, Display, bVSync ? 1 : 0, FrameCap, bLumen ? 1 : 0, bVolumetricFog ? 1 : 0, bMotionBlur ? 1 : 0, bShowFps ? 1 : 0);
	T += FString::Printf(TEXT("Master=%d\nMusic=%d\nEffects=%d\nAmbience=%d\nShake=%d\nGhost=%d\nHints=%d\nRumble=%d\n"),
		Master, Music, Effects, Ambience, Shake, bGhost ? 1 : 0, bHints ? 1 : 0, bRumble ? 1 : 0);
	FFileHelper::SaveStringToFile(T, *SettingsPath());
}

float FMcSettings::AutoResScale(int32 InQuality, int32 ScreenHeight)
{
	// Render toward a fixed number of lines and let TSR rebuild the full output resolution.
	const float Lines[] = { 760.f, 960.f, 1160.f, 1440.f };
	return FMath::Clamp(Lines[FMath::Clamp(InQuality, 0, 3)] / FMath::Max(ScreenHeight, 480) * 100.f, 50.f, 100.f);
}

void FMcSettings::ApplyGraphics(UWorld* World, bool bDisplayChanged) const
{
	UGameUserSettings* GUS = GEngine ? GEngine->GetGameUserSettings() : nullptr;
	FIntPoint ViewSize(1600, 900);
	if (World && World->GetGameViewport())
	{
		FVector2D VS;
		World->GetGameViewport()->GetViewportSize(VS);
		if (VS.X > 0) { ViewSize = FIntPoint(VS.X, VS.Y); }
	}
	if (GUS)
	{
		GUS->SetOverallScalabilityLevel(Quality);
		GUS->SetVSyncEnabled(bVSync);
		GUS->SetFrameRateLimit(FrameCap == 0 ? 60.f : FrameCap == 1 ? 120.f : 0.f);
		const bool bForeground = FPlatformApplicationMisc::IsThisApplicationForeground();
		if (bDisplayChanged && bForeground)
		{
			// Full screen is a borderless window at the desktop resolution (switching modes from the
			// background stalls on macOS, so only do it while the game is in front).
			if (Display == 1)
			{
				GUS->SetFullscreenMode(EWindowMode::WindowedFullscreen);
				GUS->SetScreenResolution(GUS->GetDesktopResolution());
			}
			else
			{
				GUS->SetFullscreenMode(EWindowMode::Windowed);
				GUS->SetScreenResolution(FIntPoint(1600, 900));
			}
		}
		if (bDisplayChanged && bForeground) { GUS->ApplySettings(false); }
		else { GUS->ApplyNonResolutionSettings(); }
	}
	// Overrides that must win over the scalability groups.
	const float Pct = ResScale > 0 ? (float)ResScale : AutoResScale(Quality, ViewSize.Y);
	SetCVarF(TEXT("r.ScreenPercentage"), Pct);
	SetCVar(TEXT("r.DynamicGlobalIlluminationMethod"), bLumen ? 1 : 0);
	SetCVar(TEXT("r.ReflectionMethod"), bLumen ? 1 : 2);
	SetCVar(TEXT("r.VolumetricFog"), bVolumetricFog ? 1 : 0);
	SetCVar(TEXT("r.SSR.Quality"), Quality >= 2 ? 3 : 2);
	// Shadows: virtual shadow maps on High+, cheaper maps below.
	SetCVar(TEXT("r.Shadow.Virtual.Enable"), Quality >= 2 ? 1 : 0);
	SetCVar(TEXT("r.Shadow.MaxCSMResolution"), Quality >= 2 ? 2048 : 1024);
	SetCVar(TEXT("r.VolumetricFog.GridPixelSize"), Quality >= 3 ? 8 : 16);
	SetCVar(TEXT("r.VolumetricFog.GridSizeZ"), Quality >= 3 ? 96 : 64);
	SetCVar(TEXT("r.Lumen.ScreenProbeGather.DownsampleFactor"), Quality >= 3 ? 16 : 32);
	UE_LOG(LogMc, Display, TEXT("MC_SETTINGS quality=%d scale=%.0f%% view=%dx%d lumen=%d vsync=%d cap=%d"), Quality, Pct, ViewSize.X, ViewSize.Y, bLumen ? 1 : 0, bVSync ? 1 : 0, FrameCap);
}

void FMcSettings::UpdateAutoScale(UWorld* World) const
{
	if (ResScale > 0 || !World || !World->GetGameViewport()) { return; }
	FVector2D VS;
	World->GetGameViewport()->GetViewportSize(VS);
	if (VS.Y <= 0) { return; }
	static int32 LastH = -1, LastQ = -1;
	if ((int32)VS.Y == LastH && Quality == LastQ) { return; }
	LastH = (int32)VS.Y; LastQ = Quality;
	const float Pct = AutoResScale(Quality, LastH);
	SetCVarF(TEXT("r.ScreenPercentage"), Pct);
	UE_LOG(LogMc, Display, TEXT("MC_AUTOSCALE view=%dx%d scale=%.0f%%"), (int32)VS.X, LastH, Pct);
}

TArray<FMcSettingRow> McBuildSettingsRows(UWorld* World, TFunction<void()> OnBack)
{
	FMcSettings& S = FMcSettings::Get();
	TArray<FMcSettingRow> R;
	auto Gfx = [World](bool bDisplay = false) { FMcSettings::Get().ApplyGraphics(World, bDisplay); FMcSettings::Get().Save(); };
	auto Cycle = [](int32& V, int32 D, int32 Min, int32 Max) { V = V + D; if (V > Max) V = Min; if (V < Min) V = Max; };
	auto Step = [](int32& V, int32 D, int32 Min, int32 Max) { V = FMath::Clamp(V + D, Min, Max); };

	const TCHAR* QualityNames[] = { TEXT("LOW"), TEXT("MEDIUM"), TEXT("HIGH"), TEXT("ULTRA") };
	R.Add({ TEXT("Quality preset"), TEXT("GRAPHICS"), [&S, QualityNames] { return FString(QualityNames[S.Quality]); },
		[&S, Gfx, Cycle](int32 D) { Cycle(S.Quality, D == 0 ? 1 : D, 0, 3); Gfx(); } });
	R.Add({ TEXT("Resolution scale"), TEXT(""), [&S, World] {
			if (S.ResScale > 0) { return FString::Printf(TEXT("%d%%"), S.ResScale); }
			FVector2D VS(1600, 900);
			if (World && World->GetGameViewport()) { World->GetGameViewport()->GetViewportSize(VS); }
			return FString::Printf(TEXT("AUTO (%d%%)"), FMath::RoundToInt(FMcSettings::AutoResScale(S.Quality, (int32)VS.Y))); },
		[&S, Gfx](int32 D) {
			int32 V = S.ResScale == 0 ? 45 : S.ResScale;
			V += (D == 0 ? 5 : D * 5);
			if (V > 100) V = 0; else if (V < 50) V = (D < 0 && S.ResScale == 50) ? 0 : 50;
			if (S.ResScale == 0 && D < 0) V = 100;
			S.ResScale = V; Gfx(); } });
	R.Add({ TEXT("Display"), TEXT(""), [&S] { return FString(S.Display ? TEXT("FULL SCREEN") : TEXT("WINDOW")); },
		[&S, Gfx](int32 D) { S.Display = 1 - S.Display; Gfx(true); } });
	R.Add({ TEXT("VSync"), TEXT(""), [&S] { return FString(OnOff(S.bVSync)); }, [&S, Gfx](int32) { S.bVSync = !S.bVSync; Gfx(); } });
	const TCHAR* CapNames[] = { TEXT("60 FPS"), TEXT("120 FPS"), TEXT("UNLIMITED") };
	R.Add({ TEXT("Frame limit"), TEXT(""), [&S, CapNames] { return FString(CapNames[S.FrameCap]); }, [&S, Gfx, Cycle](int32 D) { Cycle(S.FrameCap, D == 0 ? 1 : D, 0, 2); Gfx(); } });
	R.Add({ TEXT("Global illumination"), TEXT(""), [&S] { return FString(S.bLumen ? TEXT("LUMEN") : TEXT("OFF")); }, [&S, Gfx](int32) { S.bLumen = !S.bLumen; Gfx(); } });
	R.Add({ TEXT("Volumetric fog"), TEXT(""), [&S] { return FString(OnOff(S.bVolumetricFog)); }, [&S, Gfx](int32) { S.bVolumetricFog = !S.bVolumetricFog; Gfx(); } });
	R.Add({ TEXT("Motion blur"), TEXT(""), [&S] { return FString(OnOff(S.bMotionBlur)); }, [&S](int32) { S.bMotionBlur = !S.bMotionBlur; S.Save(); } });
	R.Add({ TEXT("Show FPS"), TEXT(""), [&S] { return FString(OnOff(S.bShowFps)); }, [&S](int32) { S.bShowFps = !S.bShowFps; S.Save(); } });

	auto Vol = [](int32 V) { return FString::Printf(TEXT("%d%%"), V * 10); };
	R.Add({ TEXT("Master volume"), TEXT("SOUND"), [&S, Vol] { return Vol(S.Master); }, [&S, Step](int32 D) { Step(S.Master, D == 0 ? 1 : D, 0, 10); S.Save(); } });
	R.Add({ TEXT("Music"), TEXT(""), [&S, Vol] { return Vol(S.Music); }, [&S, Step](int32 D) { Step(S.Music, D == 0 ? 1 : D, 0, 10); S.Save(); } });
	R.Add({ TEXT("Effects"), TEXT(""), [&S, Vol] { return Vol(S.Effects); }, [&S, Step](int32 D) { Step(S.Effects, D == 0 ? 1 : D, 0, 10); S.Save(); } });
	R.Add({ TEXT("Rain & city"), TEXT(""), [&S, Vol] { return Vol(S.Ambience); }, [&S, Step](int32 D) { Step(S.Ambience, D == 0 ? 1 : D, 0, 10); S.Save(); } });

	R.Add({ TEXT("Camera shake"), TEXT("GAMEPLAY"), [&S, Vol] { return Vol(S.Shake); }, [&S, Step](int32 D) { Step(S.Shake, D == 0 ? 1 : D, 0, 10); S.Save(); } });
	R.Add({ TEXT("Ghost of your best run"), TEXT(""), [&S] { return FString(OnOff(S.bGhost)); }, [&S](int32) { S.bGhost = !S.bGhost; S.Save(); } });
	R.Add({ TEXT("Control hints"), TEXT(""), [&S] { return FString(OnOff(S.bHints)); }, [&S](int32) { S.bHints = !S.bHints; S.Save(); } });
	R.Add({ TEXT("Controller rumble"), TEXT(""), [&S] { return FString(OnOff(S.bRumble)); }, [&S](int32) { S.bRumble = !S.bRumble; S.Save(); } });

	FMcSettingRow Back;
	Back.Label = TEXT("BACK");
	Back.Value = [] { return FString(); };
	Back.Change = [OnBack](int32 D) { if (D == 0) { OnBack(); } };
	Back.bAction = true;
	R.Add(Back);
	return R;
}
