#pragma once

#include "CoreMinimal.h"
#include "GameFramework/GameModeBase.h"
#include "GameFramework/PlayerController.h"
#include "McTypes.h"
#include "McSettings.h"
#include "McGame.generated.h"

class AMcBike;
class AMcWorld;
class UMcAudio;

enum class EMcPhase : uint8
{
	Title,
	Countdown,
	Riding,
	Respawning,
	Delivered,
	Failed,
};

enum class EMcFail : uint8 { None, Broken, Late };

/** A pop-up message on the HUD ("SOFT LANDING", "-6% KERB"). */
struct FMcCallout
{
	FString Text;
	FString Sub;
	FLinearColor Color = FLinearColor::White;
	float Age = 0.f;
	float Life = 1.6f;
	float Size = 1.f;
};

/** One recorded frame of a run (ghost playback). */
struct FMcGhostFrame
{
	FVector Pos;
	FRotator Rot;
	float Crank = 0.f;
	float Wheel = 0.f;
	float Crouch = 0.f;
};

struct FMcRunResult
{
	float Time = 0.f;
	float Condition = 0.f;
	float Tip = 0.f;
	float TimeBonus = 0.f;
	float CareMultiplier = 1.f;
	float PristineBonus = 0.f;
	FString Grade;
	int32 Landings = 0;
	int32 PerfectLandings = 0;
	int32 Crashes = 0;
	float AirTime = 0.f;
	float TopSpeed = 0.f;
	TArray<FString> RoutesTaken;
};

UCLASS()
class AMcPlayerController : public APlayerController
{
	GENERATED_BODY()
public:
	AMcPlayerController();
	virtual void BeginPlay() override;
};

UCLASS()
class AMcGameMode : public AGameModeBase
{
	GENERATED_BODY()

public:
	AMcGameMode();
	virtual void StartPlay() override;
	virtual void Tick(float DeltaSeconds) override;

	// ---- state the HUD reads ----------------------------------------------------------------------------
	EMcPhase Phase = EMcPhase::Title;
	EMcFail Fail = EMcFail::None;
	float PhaseTime = 0.f;
	float RunTime = 0.f;
	float TimeLimit = 120.f;
	int32 NextCheckpoint = 0;
	TArray<float> Splits;            // this run
	TArray<float> BestSplits;        // best run (by tip)
	float LastSplitDelta = 0.f;
	float LastSplitAge = 100.f;
	FString LastSplitName;
	TArray<FMcCallout> Callouts;
	FMcRunResult Result;
	FMcRunResult Best;
	bool bHasBest = false;
	bool bNewBest = false;
	bool bPaused = false;
	int32 PauseIndex = 0;
	int32 TitleIndex = 0;
	bool bSettingsOpen = false;
	int32 SettingsIndex = 0;
	TArray<FMcSettingRow> SettingsRows;
	float MeasuredFps = 0.f;
	void OpenSettings();
	void CloseSettings();
	int32 RunCount = 0;
	float DamageFlash = 0.f;
	float LastDamage = 0.f;
	float CleanStreak = 0.f;          // seconds without package damage
	bool bGhostEnabled = true;
	float DistanceToGoal = 0.f;
	float GoalBearing = 0.f;          // degrees relative to camera yaw
	float Fade = 1.f;                 // 0 clear .. 1 black
	FString Prompt;

	AMcBike* GetBike() const { return Bike; }
	AMcWorld* GetCourierWorld() const { return World; }
	AMcBike* GetGhost() const { return Ghost; }
	bool IsGhostVisible() const;

	void Restart();

protected:
	void ReadInput(float Dt);
	void UpdateRiding(float Dt);
	void UpdateAutopilot(FMcInput& In, float Dt);
	void HandleShocks();
	void EnterPhase(EMcPhase P);
	void Deliver();
	void FailRun(EMcFail Why);
	void Respawn();
	void AddCallout(const FString& Text, const FString& Sub, const FLinearColor& Color, float Size = 1.f, float Life = 1.6f);
	void ComputeResult();
	void LoadBest();
	void SaveBest();
	void UpdateGhost(float Dt);
	void UpdateTitleCamera(float Dt);
	void TickDev(float Dt);

	UPROPERTY() TObjectPtr<AMcBike> Bike;
	UPROPERTY() TObjectPtr<AMcBike> Ghost;
	UPROPERTY() TObjectPtr<AMcWorld> World;
	UPROPERTY() TObjectPtr<UMcAudio> Audio;

	TArray<FMcGhostFrame> Recording;
	TArray<FMcGhostFrame> BestGhost;
	float RecordAccum = 0.f;

	// Safe respawn points sampled while riding.
	struct FSafePoint { FVector Pos; float Yaw; float Time; int32 Checkpoint; };
	TArray<FSafePoint> SafePoints;
	float SafeAccum = 0.f;
	float GroundedFor = 0.f;
	FSafePoint RespawnAt;

	// Input edge detection.
	bool bRestartPrev = false, bConfirmPrev = false, bPausePrev = false, bUpPrev = false, bDownPrev = false, bGhostPrev = false, bLeftPrev = false, bRightPrev = false, bBackPrev = false;
	float RepeatTimer = 0.f;
	bool bDisplayApplied = false;
	void Rumble(float Strength, float Duration);

	// Autopilot.
	bool bAutopilot = false;
	FString AutoRoute = TEXT("main");
	int32 AutoIndex = 0;
	bool bAutoBraceHeld = false;
	float AutoHopTimer = 0.f;

	// Dev / test.
	struct FShot { FString Name; float Time; bool bTaken = false; };
	TArray<FShot> Shots;
	float QuitAt = -1.f;
	float DevClock = 0.f;
	struct FScripted { FString Control; float Value; float Start; float Duration; };
	TArray<FScripted> Script;
	TArray<FScripted> MenuKeys;
	bool bTelemetry = false;
	float TelemetryAccum = 0.f;
	bool bFixedCam = false;
	FVector FixedCamPos; FRotator FixedCamRot;
	float TitleOrbit = 0.f;
	bool bSkipTitle = false;
	TArray<FString> RouteFlags;
	float AirTimeThisJump = 0.f;
	FVector ResultCamFrom = FVector::ZeroVector;
	FRotator ResultCamRotFrom = FRotator::ZeroRotator;
	float ResultOrbitYaw = 0.f;
	FString FilmName;
	float FilmStart = 0.f;
	int32 FilmFrame = 0;
	float PerfTime = 0.f, PerfWorst = 0.f;
	int32 PerfFrames = 0;
};
