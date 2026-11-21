#include "McGame.h"

#include "Camera/CameraComponent.h"
#include "Engine/Engine.h"
#include "Engine/GameViewportClient.h"
#include "Engine/World.h"
#include "HAL/FileManager.h"
#include "InputCoreTypes.h"
#include "Kismet/GameplayStatics.h"
#include "McAssets.h"
#include "McAudio.h"
#include "McBike.h"
#include "McHud.h"
#include "McSettings.h"
#include "HAL/PlatformApplicationMisc.h"
#include "McWorld.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Serialization/BufferArchive.h"
#include "Serialization/MemoryReader.h"
#include "UnrealClient.h"

namespace
{
	const FLinearColor ColGood(0.35f, 1.f, 0.75f);
	const FLinearColor ColGold(1.f, 0.78f, 0.25f);
	const FLinearColor ColBad(1.f, 0.32f, 0.25f);
	const FLinearColor ColWarn(1.f, 0.62f, 0.2f);
	const FLinearColor ColInfo(0.6f, 0.85f, 1.f);
	constexpr int32 SaveVersion = 3;
}

AMcPlayerController::AMcPlayerController()
{
	bShowMouseCursor = false;
}

void AMcPlayerController::BeginPlay()
{
	Super::BeginPlay();
	SetInputMode(FInputModeGameOnly());
}

AMcGameMode::AMcGameMode()
{
	PrimaryActorTick.bCanEverTick = true;
	PrimaryActorTick.TickGroup = TG_PrePhysics;
	DefaultPawnClass = nullptr;
	PlayerControllerClass = AMcPlayerController::StaticClass();
	HUDClass = AMcHud::StaticClass();
}

void AMcGameMode::StartPlay()
{
	Super::StartPlay();
	const TCHAR* Cmd = FCommandLine::Get();
	if (GEngine && !FParse::Param(Cmd, TEXT("McDebugMessages"))) { GEngine->bEnableOnScreenDebugMessages = false; }
	if (APlayerController* PC0 = GetWorld()->GetFirstPlayerController()) { PC0->ConsoleCommand(TEXT("DisableAllScreenMessages")); }

	FActorSpawnParameters SP;
	SP.SpawnCollisionHandlingOverride = ESpawnActorCollisionHandlingMethod::AlwaysSpawn;
	World = GetWorld()->SpawnActor<AMcWorld>(AMcWorld::StaticClass(), FTransform::Identity, SP);

	Bike = GetWorld()->SpawnActor<AMcBike>(AMcBike::StaticClass(), FTransform(FRotator(0, World->StartYaw, 0), World->StartPos), SP);
	Ghost = GetWorld()->SpawnActor<AMcBike>(AMcBike::StaticClass(), FTransform(FRotator(0, World->StartYaw, 0), World->StartPos), SP);
	Ghost->bGhost = true;
	Ghost->MakeGhost(McAssets::Material(TEXT("M_Ghost")));
	Ghost->SetActorHiddenInGame(true);

	if (APlayerController* PC = GetWorld()->GetFirstPlayerController())
	{
		PC->Possess(Bike);
		PC->SetViewTarget(Bike);
	}
	World->ApplyPostProcess(Bike->Camera->PostProcessSettings);
	Bike->Camera->PostProcessBlendWeight = 1.f;

	Audio = NewObject<UMcAudio>(this);
	Audio->Init(GetWorld(), Bike);

	// ---- dev / test switches ----------------------------------------------------------------------------
	FString ShotList;
	if (FParse::Value(Cmd, TEXT("McShots="), ShotList, false))
	{
		TArray<FString> Items;
		ShotList.ParseIntoArray(Items, TEXT(","));
		for (const FString& It : Items)
		{
			FString Name, At;
			if (It.Split(TEXT("@"), &Name, &At)) { Shots.Add({ Name, FCString::Atof(*At) }); }
		}
	}
	FParse::Value(Cmd, TEXT("McQuit="), QuitAt);
	FParse::Value(Cmd, TEXT("McFilm="), FilmName);
	FParse::Value(Cmd, TEXT("McFilmStart="), FilmStart);
	FString Auto;
	if (FParse::Value(Cmd, TEXT("McAuto="), Auto)) { bAutopilot = true; AutoRoute = Auto; }
	else if (FParse::Param(Cmd, TEXT("McAuto"))) { bAutopilot = true; }
	AMcBike::bInvincible = FParse::Param(Cmd, TEXT("McInvincible"));
	bTelemetry = FParse::Param(Cmd, TEXT("McTelemetry"));
	bSkipTitle = FParse::Param(Cmd, TEXT("McRide")) || bAutopilot || FParse::Param(Cmd, TEXT("McScript"));
	FString ScriptStr;
	if (FParse::Value(Cmd, TEXT("McScript="), ScriptStr, false))
	{
		// control[=value]@start:duration, ...  e.g. throttle@0:4,steer=-0.5@2:1,brace@5:0.3
		bSkipTitle = true;
		TArray<FString> Items;
		ScriptStr.ParseIntoArray(Items, TEXT(","));
		for (const FString& It : Items)
		{
			FString Ctl, When, StartS, DurS;
			if (!It.Split(TEXT("@"), &Ctl, &When)) { continue; }
			if (!When.Split(TEXT(":"), &StartS, &DurS)) { StartS = When; DurS = TEXT("0.1"); }
			FString Name = Ctl, Val = TEXT("1");
			Ctl.Split(TEXT("="), &Name, &Val);
			Script.Add({ Name, FCString::Atof(*Val), FCString::Atof(*StartS), FCString::Atof(*DurS) });
		}
	}
	FString KeyStr;
	if (FParse::Value(Cmd, TEXT("McKeys="), KeyStr, false))
	{
		TArray<FString> Items;
		KeyStr.ParseIntoArray(Items, TEXT(","));
		for (const FString& It : Items)
		{
			FString Name, At;
			if (It.Split(TEXT("@"), &Name, &At)) { MenuKeys.Add({ Name, 1.f, FCString::Atof(*At), 0.1f }); }
		}
	}
	FString CamStr;
	if (FParse::Value(Cmd, TEXT("McCam="), CamStr, false))
	{
		TArray<FString> P; CamStr.ParseIntoArray(P, TEXT(","));
		if (P.Num() >= 5)
		{
			bFixedCam = true;
			FixedCamPos = FVector(FCString::Atof(*P[0]), FCString::Atof(*P[1]), FCString::Atof(*P[2]));
			FixedCamRot = FRotator(FCString::Atof(*P[3]), FCString::Atof(*P[4]), 0.f);
		}
	}
	FString TeleStr;
	if (FParse::Value(Cmd, TEXT("McTele="), TeleStr, false))
	{
		TArray<FString> P; TeleStr.ParseIntoArray(P, TEXT(","));
		if (P.Num() >= 4)
		{
			World->StartPos = FVector(FCString::Atof(*P[0]), FCString::Atof(*P[1]), FCString::Atof(*P[2]));
			World->StartYaw = FCString::Atof(*P[3]);
		}
	}
	FMcSettings& Settings = FMcSettings::Get();
	bGhostEnabled = Settings.bGhost;
	if (FParse::Param(Cmd, TEXT("McNoGhost"))) { bGhostEnabled = false; }
	Settings.ApplyGraphics(GetWorld(), false);
	bDisplayApplied = Settings.Display == 0 || FParse::Param(Cmd, TEXT("McWindow"));
	if (FParse::Param(Cmd, TEXT("McFresh")))
	{
		bHasBest = false;
	}
	else
	{
		LoadBest();
	}

	Bike->ResetTo(World->StartPos, World->StartYaw, 0.f);
	Bike->SetFrozen(true);
	Bike->SnapCamera();
	if (bSkipTitle) { Restart(); }
	else { EnterPhase(EMcPhase::Title); }
}

void AMcGameMode::OpenSettings()
{
	bSettingsOpen = true;
	SettingsIndex = 0;
	SettingsRows = McBuildSettingsRows(GetWorld(), [this] { CloseSettings(); });
}

void AMcGameMode::CloseSettings()
{
	bSettingsOpen = false;
	SettingsRows.Reset();
	bGhostEnabled = FMcSettings::Get().bGhost;
	FMcSettings::Get().Save();
}

void AMcGameMode::Rumble(float Strength, float Duration)
{
	if (!FMcSettings::Get().bRumble || bAutopilot) { return; }
	if (APlayerController* PC = GetWorld()->GetFirstPlayerController())
	{
		const float I = FMath::Clamp(Strength, 0.f, 1.f);
		PC->PlayDynamicForceFeedback(I, Duration, true, true, true, true);
	}
}

void AMcGameMode::EnterPhase(EMcPhase P)
{
	Phase = P;
	PhaseTime = 0.f;
	if (Audio) { Audio->OnPhase(P); }
}

bool AMcGameMode::IsGhostVisible() const
{
	return Ghost && !Ghost->IsHidden();
}

void AMcGameMode::Restart()
{
	++RunCount;
	Bike->ResetTo(World->StartPos, World->StartYaw, 0.f);
	Bike->SetCondition(100.f);
	Bike->SetFrozen(true);
	Bike->SnapCamera();
	RunTime = 0.f;
	NextCheckpoint = 0;
	Splits.Reset();
	Callouts.Reset();
	Recording.Reset();
	RecordAccum = 0.f;
	SafePoints.Reset();
	SafeAccum = 0.f;
	GroundedFor = 0.f;
	RespawnAt = { World->StartPos, World->StartYaw, 0.f, 0 };
	Result = FMcRunResult();
	RouteFlags.Reset();
	Fail = EMcFail::None;
	bNewBest = false;
	bPaused = false;
	LastSplitAge = 100.f;
	DamageFlash = 0.f;
	CleanStreak = 0.f;
	AutoIndex = 0;
	Fade = 0.f;
	World->SetGoalActive(true);
	if (Ghost)
	{
		Ghost->SetActorHiddenInGame(!(bGhostEnabled && BestGhost.Num() > 1));
		if (BestGhost.Num() > 0) { Ghost->SetPoseFromRecording(BestGhost[0].Pos, BestGhost[0].Rot, 0.f, 0.f, 0.f); }
	}
	EnterPhase(EMcPhase::Countdown);
	if (Audio) { Audio->OnRestart(); }
}

void AMcGameMode::AddCallout(const FString& Text, const FString& Sub, const FLinearColor& Color, float Size, float Life)
{
	// Keep the stack short; merge repeats of the same text.
	for (FMcCallout& C : Callouts)
	{
		if (C.Text == Text && C.Age < 0.5f) { C.Sub = Sub; C.Age = 0.f; return; }
	}
	FMcCallout C;
	C.Text = Text; C.Sub = Sub; C.Color = Color; C.Size = Size; C.Life = Life;
	Callouts.Insert(C, 0);
	if (Callouts.Num() > 4) { Callouts.SetNum(4); }
}

// ======================================================================================================
// Input
// ======================================================================================================
void AMcGameMode::ReadInput(float Dt)
{
	APlayerController* PC = GetWorld()->GetFirstPlayerController();
	FMcInput In;
	bool bRestart = false, bConfirm = false, bPause = false, bUp = false, bDown = false, bGhostKey = false, bLeft = false, bRight = false, bBack = false;
	if (PC)
	{
		auto Key = [PC](const FKey& K) { return PC->IsInputKeyDown(K); };
		auto Axis = [PC](const FKey& K) { return PC->GetInputAnalogKeyState(K); };
		const float StickX = Axis(EKeys::Gamepad_LeftX);
		const float StickY = Axis(EKeys::Gamepad_LeftY);
		float Steer = (Key(EKeys::D) || Key(EKeys::Right) ? 1.f : 0.f) - (Key(EKeys::A) || Key(EKeys::Left) ? 1.f : 0.f);
		if (FMath::Abs(StickX) > 0.12f) { Steer = FMath::Sign(StickX) * FMath::Square((FMath::Abs(StickX) - 0.12f) / 0.88f) * 0.6f + StickX * 0.4f; }
		In.Steer = FMath::Clamp(Steer, -1.f, 1.f);
		const bool bW = Key(EKeys::W) || Key(EKeys::Up);
		const bool bS = Key(EKeys::S) || Key(EKeys::Down);
		In.Throttle = FMath::Max(bW ? 1.f : 0.f, Axis(EKeys::Gamepad_RightTriggerAxis));
		In.Brake = FMath::Max(bS ? 1.f : 0.f, Axis(EKeys::Gamepad_LeftTriggerAxis));
		In.Lean = (bW ? 1.f : 0.f) - (bS ? 1.f : 0.f);
		if (FMath::Abs(StickY) > 0.2f) { In.Lean = -StickY; }
		In.bBrace = Key(EKeys::SpaceBar) || Key(EKeys::Gamepad_FaceButton_Bottom);
		In.bDrift = Key(EKeys::LeftShift) || Key(EKeys::RightShift) || Key(EKeys::Gamepad_FaceButton_Left) || Key(EKeys::Gamepad_RightShoulder);
		bRestart = Key(EKeys::R) || Key(EKeys::Gamepad_FaceButton_Top) || Key(EKeys::BackSpace);
		bConfirm = Key(EKeys::Enter) || Key(EKeys::SpaceBar) || Key(EKeys::Gamepad_FaceButton_Bottom) || Key(EKeys::Gamepad_Special_Right);
		bPause = Key(EKeys::Escape) || Key(EKeys::P) || Key(EKeys::Gamepad_Special_Right);
		bUp = Key(EKeys::W) || Key(EKeys::Up) || Key(EKeys::Gamepad_DPad_Up) || StickY > 0.6f;
		bDown = Key(EKeys::S) || Key(EKeys::Down) || Key(EKeys::Gamepad_DPad_Down) || StickY < -0.6f;
		bGhostKey = Key(EKeys::G) || Key(EKeys::Gamepad_Special_Left);
		bLeft = Key(EKeys::A) || Key(EKeys::Left) || Key(EKeys::Gamepad_DPad_Left) || StickX < -0.6f;
		bRight = Key(EKeys::D) || Key(EKeys::Right) || Key(EKeys::Gamepad_DPad_Right) || StickX > 0.6f;
		bBack = Key(EKeys::Escape) || Key(EKeys::Gamepad_FaceButton_Right);
	}

	// Scripted menu keys (tests): name@seconds, held for 0.1 s.
	for (const FScripted& K : MenuKeys)
	{
		if (DevClock < K.Start || DevClock > K.Start + 0.1f) { continue; }
		if (K.Control == TEXT("Up")) bUp = true;
		else if (K.Control == TEXT("Down")) bDown = true;
		else if (K.Control == TEXT("Left")) bLeft = true;
		else if (K.Control == TEXT("Right")) bRight = true;
		else if (K.Control == TEXT("Enter")) bConfirm = true;
		else if (K.Control == TEXT("Esc")) { bBack = true; bPause = true; }
		else if (K.Control == TEXT("R")) bRestart = true;
	}

	// Scripted input (tests) overrides the keyboard.
	if (Script.Num() > 0)
	{
		In = FMcInput();
		// Script times count from the moment riding starts.
		const float Clock = Phase == EMcPhase::Riding || Phase == EMcPhase::Respawning ? RunTime : -1.f;
		for (const FScripted& S : Script)
		{
			if (Clock < S.Start || Clock > S.Start + S.Duration) { continue; }
			if (S.Control == TEXT("throttle")) { In.Throttle = S.Value; }
			else if (S.Control == TEXT("brake")) { In.Brake = S.Value; }
			else if (S.Control == TEXT("steer")) { In.Steer = S.Value; }
			else if (S.Control == TEXT("lean")) { In.Lean = S.Value; }
			else if (S.Control == TEXT("brace")) { In.bBrace = true; }
			else if (S.Control == TEXT("drift")) { In.bDrift = true; }
			else if (S.Control == TEXT("restart")) { bRestart = true; }
			else if (S.Control == TEXT("auto")) { bAutopilot = S.Value > 0.5f; }
		}
	}
	if (bAutopilot && Phase == EMcPhase::Riding) { UpdateAutopilot(In, Dt); }

	const bool bRestartEdge = bRestart && !bRestartPrev;
	const bool bConfirmEdge = bConfirm && !bConfirmPrev;
	const bool bPauseEdge = bPause && !bPausePrev;
	const bool bUpEdge = bUp && !bUpPrev, bDownEdge = bDown && !bDownPrev;
	const bool bGhostEdge = bGhostKey && !bGhostPrev;
	// Held directions repeat in menus.
	bool bLeftEdge = bLeft && !bLeftPrev, bRightEdge = bRight && !bRightPrev;
	bool bUpRep = bUpEdge, bDownRep = bDownEdge;
	if (bLeft || bRight || bUp || bDown)
	{
		RepeatTimer += Dt;
		if (RepeatTimer > 0.4f)
		{
			RepeatTimer -= 0.09f;
			bLeftEdge |= bLeft; bRightEdge |= bRight; bUpRep |= bUp; bDownRep |= bDown;
		}
	}
	else { RepeatTimer = 0.f; }
	const bool bBackEdge = bBack && !bBackPrev;
	bRestartPrev = bRestart; bConfirmPrev = bConfirm; bPausePrev = bPause; bUpPrev = bUp; bDownPrev = bDown; bGhostPrev = bGhostKey;
	bLeftPrev = bLeft; bRightPrev = bRight; bBackPrev = bBack;

	// Settings screen (from the title or the pause menu) takes all input while open.
	if (bSettingsOpen)
	{
		if (SettingsRows.Num() > 0)
		{
			if (bUpRep) { SettingsIndex = (SettingsIndex + SettingsRows.Num() - 1) % SettingsRows.Num(); if (Audio) { Audio->Ui(TEXT("Move")); } }
			if (bDownRep) { SettingsIndex = (SettingsIndex + 1) % SettingsRows.Num(); if (Audio) { Audio->Ui(TEXT("Move")); } }
			FMcSettingRow& Row = SettingsRows[SettingsIndex];
			if (bLeftEdge && !Row.bAction) { Row.Change(-1); if (Audio) { Audio->Ui(TEXT("Move")); } }
			if (bRightEdge && !Row.bAction) { Row.Change(1); if (Audio) { Audio->Ui(TEXT("Move")); } }
			if (bConfirmEdge) { Row.Change(0); if (Audio) { Audio->Ui(TEXT("Select")); } }
		}
		if (bBackEdge || bPauseEdge) { CloseSettings(); }
		Bike->Input = FMcInput();
		return;
	}

	if (bGhostEdge)
	{
		bGhostEnabled = !bGhostEnabled;
		FMcSettings::Get().bGhost = bGhostEnabled;
		FMcSettings::Get().Save();
		if (Ghost) { Ghost->SetActorHiddenInGame(!(bGhostEnabled && BestGhost.Num() > 1 && (Phase == EMcPhase::Riding || Phase == EMcPhase::Countdown))); }
		AddCallout(bGhostEnabled ? TEXT("GHOST ON") : TEXT("GHOST OFF"), TEXT(""), ColInfo, 0.7f, 1.0f);
	}

	if (bPaused)
	{
		if (bPauseEdge) { bPaused = false; }
		if (bUpRep) { PauseIndex = (PauseIndex + 3) % 4; if (Audio) { Audio->Ui(TEXT("Move")); } }
		if (bDownRep) { PauseIndex = (PauseIndex + 1) % 4; if (Audio) { Audio->Ui(TEXT("Move")); } }
		if (bBackEdge && !bPauseEdge) { bPaused = false; }
		if (bConfirmEdge)
		{
			if (Audio) { Audio->Ui(TEXT("Select")); }
			if (PauseIndex == 0) { bPaused = false; }
			else if (PauseIndex == 1) { Restart(); }
			else if (PauseIndex == 2) { OpenSettings(); }
			else if (PauseIndex == 3) { bPaused = false; EnterPhase(EMcPhase::Title); Bike->SetFrozen(true); Fade = 0.f; TitleIndex = 0; }
		}
		if (bRestartEdge) { Restart(); }
		Bike->Input = FMcInput();
		return;
	}

	switch (Phase)
	{
	case EMcPhase::Title:
		if (bUpRep) { TitleIndex = (TitleIndex + 2) % 3; if (Audio) { Audio->Ui(TEXT("Move")); } }
		if (bDownRep) { TitleIndex = (TitleIndex + 1) % 3; if (Audio) { Audio->Ui(TEXT("Move")); } }
		if (bRestartEdge && PhaseTime > 0.6f) { Restart(); }
		else if (bConfirmEdge && PhaseTime > 0.6f)
		{
			if (Audio) { Audio->Ui(TEXT("Select")); }
			if (TitleIndex == 0) { Restart(); }
			else if (TitleIndex == 1) { OpenSettings(); }
			else if (APlayerController* QPC = GetWorld()->GetFirstPlayerController()) { QPC->ConsoleCommand(TEXT("quit")); }
		}
		break;
	case EMcPhase::Countdown:
	case EMcPhase::Riding:
	case EMcPhase::Respawning:
		if (bRestartEdge) { Restart(); return; }
		if ((bPauseEdge || bBackEdge) && Script.Num() == 0 && !bAutopilot) { bPaused = true; PauseIndex = 0; if (Audio) { Audio->Ui(TEXT("Pause")); } }
		break;
	case EMcPhase::Delivered:
	case EMcPhase::Failed:
		if ((bRestartEdge || (bConfirmEdge && PhaseTime > 1.2f))) { Restart(); return; }
		if (bPauseEdge || bBackEdge) { EnterPhase(EMcPhase::Title); TitleIndex = 0; }
		break;
	}
	Bike->Input = (Phase == EMcPhase::Riding) ? In : FMcInput();
}

void AMcGameMode::UpdateAutopilot(FMcInput& In, float Dt)
{
	const TArray<FMcRoutePoint>* R = World->Routes.Find(AutoRoute);
	if (!R || R->Num() < 2) { return; }
	const FVector P = Bike->GetWorldLocation();
	// Advance along the route: the next point we haven't passed.
	while (AutoIndex < R->Num() - 1)
	{
		const FVector A = (*R)[AutoIndex].Pos, B = (*R)[AutoIndex + 1].Pos;
		const FVector2D AB(B.X - A.X, B.Y - A.Y), AP(P.X - A.X, P.Y - A.Y);
		const float T = FVector2D::DotProduct(AP, AB) / FMath::Max(1.f, AB.SizeSquared());
		if (T > 1.f) { ++AutoIndex; } else { break; }
	}
	const int32 I = FMath::Min(AutoIndex, R->Num() - 2);
	// Look-ahead point along the polyline.
	const float Speed = Bike->GetSpeed();
	float Ahead = FMath::Max(350.f, Speed * 55.f);
	FVector Target = (*R)[I + 1].Pos;
	{
		const FVector A = (*R)[I].Pos, B = (*R)[I + 1].Pos;
		const FVector2D AB(B.X - A.X, B.Y - A.Y), AP(P.X - A.X, P.Y - A.Y);
		const float Len = AB.Size();
		float T = FMath::Clamp(FVector2D::DotProduct(AP, AB) / FMath::Max(1.f, Len * Len), 0.f, 1.f);
		float Remaining = Ahead;
		int32 Seg = I;
		float SegT = T;
		while (Seg < R->Num() - 1)
		{
			const FVector SA = (*R)[Seg].Pos, SB = (*R)[Seg + 1].Pos;
			const float SL = FVector2D(SB.X - SA.X, SB.Y - SA.Y).Size();
			const float Left = SL * (1.f - SegT);
			if (Remaining <= Left) { Target = SA + (SB - SA) * (SegT + Remaining / FMath::Max(SL, 1.f)); break; }
			Remaining -= Left;
			++Seg; SegT = 0.f;
			Target = SB;
		}
	}
	const FVector2D ToT(Target.X - P.X, Target.Y - P.Y);
	const float WantYaw = FMath::RadiansToDegrees(FMath::Atan2(ToT.Y, ToT.X));
	const float Err = FMath::FindDeltaAngleDegrees(Bike->GetYawDeg(), WantYaw);
	In.Steer = FMath::Clamp(Err / 22.f, -1.f, 1.f);
	const FMcRoutePoint& Next = (*R)[FMath::Min(I + 1, R->Num() - 1)];
	const FMcRoutePoint& Cur = (*R)[I];
	// Target speed: the lower of this segment's and an anticipation of the next one.
	const float DistNext = FVector2D(Next.Pos.X - P.X, Next.Pos.Y - P.Y).Size() / 100.f;
	const float Anticipate = FMath::Sqrt(FMath::Square(Next.Speed) + 2.f * 5.5f * DistNext);
	const float Want = FMath::Min(Cur.Speed, Anticipate);
	In.Throttle = Speed < Want - 0.3f ? 1.f : 0.f;
	In.Brake = Speed > Want + 0.6f ? FMath::Clamp((Speed - Want) / 3.f, 0.2f, 1.f) : 0.f;
	In.Lean = 0.f;
	In.bBrace = Cur.bBrace || (!Bike->IsGrounded() && Bike->GetAirTime() > 0.25f);
	In.bDrift = false;
	// Hops: hold brace briefly then release when passing a hop point.
	if (AutoHopTimer > 0.f)
	{
		AutoHopTimer -= Dt;
		In.bBrace = AutoHopTimer > 0.06f;
	}
	else if (Next.bHop && DistNext < FMath::Max(1.5f, Speed * 0.12f))
	{
		AutoHopTimer = 0.32f;
		In.bBrace = true;
	}
}

// ======================================================================================================
// Frame
// ======================================================================================================
void AMcGameMode::Tick(float DeltaSeconds)
{
	Super::Tick(DeltaSeconds);
	const float Dt = FMath::Min(DeltaSeconds, 0.05f);
	DevClock += DeltaSeconds;
	ReadInput(Dt);

	if (!bDisplayApplied && DevClock > 1.f && FPlatformApplicationMisc::IsThisApplicationForeground())
	{
		bDisplayApplied = true;
		FMcSettings::Get().ApplyGraphics(GetWorld(), true);
	}
	FMcSettings::Get().UpdateAutoScale(GetWorld());
	MeasuredFps = FMath::Lerp(MeasuredFps, 1.f / FMath::Max(DeltaSeconds, 1e-4f), FMath::Min(1.f, DeltaSeconds * 3.f));
	if (bPaused || bSettingsOpen)
	{
		Bike->SetFrozen(true);
		World->SetFocus(Bike->Camera->GetComponentLocation(), FVector::ZeroVector);
		if (Audio) { Audio->Update(Dt, this); }
		TickDev(DeltaSeconds);
		return;
	}
	if (Phase == EMcPhase::Riding) { Bike->SetFrozen(false); }
	PhaseTime += Dt;
	for (FMcCallout& C : Callouts) { C.Age += Dt; }
	Callouts.RemoveAll([](const FMcCallout& C) { return C.Age > C.Life; });
	LastSplitAge += Dt;
	DamageFlash = FMath::Max(0.f, DamageFlash - Dt * 2.5f);

	switch (Phase)
	{
	case EMcPhase::Title:
		Bike->SetFrozen(true);
		Fade = FMath::Max(0.f, Fade - Dt * 0.8f);
		UpdateTitleCamera(Dt);
		break;
	case EMcPhase::Countdown:
		Bike->SetFrozen(true);
		Fade = FMath::Max(0.f, Fade - Dt * 4.f);
		if (PhaseTime >= 1.5f)
		{
			Bike->SetFrozen(false);
			EnterPhase(EMcPhase::Riding);
		}
		break;
	case EMcPhase::Riding:
		UpdateRiding(Dt);
		break;
	case EMcPhase::Respawning:
		RunTime += Dt;
		if (PhaseTime > 1.3f && PhaseTime - Dt <= 1.3f)
		{
			Respawn();
		}
		Fade = PhaseTime < 1.0f ? FMath::Clamp((PhaseTime - 0.7f) / 0.3f, 0.f, 1.f) : FMath::Clamp(1.f - (PhaseTime - 1.3f) / 0.35f, 0.f, 1.f);
		if (PhaseTime > 1.7f) { Fade = 0.f; EnterPhase(EMcPhase::Riding); }
		break;
	case EMcPhase::Delivered:
	case EMcPhase::Failed:
	{
		Bike->Input = FMcInput();
		Bike->Input.Brake = 1.f;
		// Results: drift from the chase camera into a slow orbit around the courier.
		if (PhaseTime < Dt * 1.5f)
		{
			ResultCamFrom = Bike->Camera->GetComponentLocation();
			ResultCamRotFrom = Bike->Camera->GetComponentRotation();
			ResultOrbitYaw = Bike->Camera->GetComponentRotation().Yaw;
		}
		ResultOrbitYaw += Dt * 9.f;
		const FVector C = (Bike->IsCrashed() ? Bike->GetPackageWorldLocation() : Bike->GetWorldLocation()) + FVector(0, 0, 110.f);
		const FRotator OR(-12.f, ResultOrbitYaw, 0.f);
		const FVector OL = C - OR.Vector() * 430.f;
		const float A = FMath::SmoothStep(0.f, 1.f, FMath::Clamp(PhaseTime / 1.6f, 0.f, 1.f));
		Bike->bCameraOverride = true;
		Bike->OverrideLoc = FMath::Lerp(ResultCamFrom, OL, A);
		Bike->OverrideRot = FMath::Lerp(ResultCamRotFrom, (C - Bike->OverrideLoc).Rotation(), A);
		Bike->OverrideFov = FMath::Lerp(80.f, 50.f, A);
		break;
	}
	}

	if (Phase == EMcPhase::Riding || Phase == EMcPhase::Countdown || Phase == EMcPhase::Respawning) { UpdateGhost(Dt); }

	// Where is the drop-off relative to the view?
	{
		const FVector P = Bike->GetWorldLocation();
		DistanceToGoal = FVector::Dist2D(P, World->GoalPos) / 100.f;
		const float CamYaw = Bike->Camera->GetComponentRotation().Yaw;
		const float GoalYaw = FMath::RadiansToDegrees(FMath::Atan2(World->GoalPos.Y - P.Y, World->GoalPos.X - P.X));
		GoalBearing = FMath::FindDeltaAngleDegrees(CamYaw, GoalYaw);
	}
	World->SetFocus(Bike->Camera->GetComponentLocation(), Bike->GetWorldVelocity());
	World->SetLamp(Bike->GetHeadLampLocation(), Bike->GetHeadLampDirection());
	World->ApplyPostProcess(Bike->Camera->PostProcessSettings);
	// Speed and damage push the grade a little.
	{
		FPostProcessSettings& PP = Bike->Camera->PostProcessSettings;
		const float Sp = FMath::Clamp((Bike->GetSpeed() - 8.f) / 10.f, 0.f, 1.f);
		PP.SceneFringeIntensity = 0.3f + Sp * 1.6f + DamageFlash * 3.f;
		PP.VignetteIntensity = 0.5f + Sp * 0.15f + DamageFlash * 0.4f;
		if (Phase == EMcPhase::Title || Phase == EMcPhase::Delivered || Phase == EMcPhase::Failed)
		{
			PP.bOverride_DepthOfFieldFocalDistance = true; PP.DepthOfFieldFocalDistance = 600.f;
			PP.bOverride_DepthOfFieldFstop = true; PP.DepthOfFieldFstop = 2.2f;
		}
		else
		{
			PP.bOverride_DepthOfFieldFocalDistance = false;
			PP.bOverride_DepthOfFieldFstop = false;
		}
	}
	if (Audio) { Audio->Update(Dt, this); }
	if (Phase != EMcPhase::Title && Phase != EMcPhase::Delivered && Phase != EMcPhase::Failed) { Bike->bCameraOverride = false; }
	if (bFixedCam)
	{
		Bike->bCameraOverride = true;
		Bike->OverrideLoc = FixedCamPos;
		Bike->OverrideRot = FixedCamRot;
		Bike->OverrideFov = 70.f;
	}
	TickDev(DeltaSeconds);
}

void AMcGameMode::UpdateRiding(float Dt)
{
	RunTime += Dt;
	HandleShocks();

	// Records for the ghost: 30 Hz.
	RecordAccum += Dt;
	if (RecordAccum >= 1.f / 30.f)
	{
		RecordAccum -= 1.f / 30.f;
		const FTransform T = Bike->GetBodyTransform();
		FMcGhostFrame F;
		F.Pos = Bike->GetWorldLocation();
		F.Rot = FRotator(Bike->GetPitchDeg(), Bike->GetYawDeg(), Bike->GetLeanDeg());
		F.Crank = 0.f; F.Wheel = Bike->GetWheelSpin(); F.Crouch = Bike->IsBraced() ? -0.12f : 0.f;
		Recording.Add(F);
	}

	// Safe points for respawning after a crash.
	if (Bike->IsGrounded() && Bike->GetSpeed() > 2.f && Bike->GetShake() < 0.3f) { GroundedFor += Dt; } else { GroundedFor = 0.f; }
	SafeAccum += Dt;
	if (GroundedFor > 0.6f && SafeAccum > 0.25f)
	{
		SafeAccum = 0.f;
		const FVector V = Bike->GetWorldVelocity();
		SafePoints.Add({ Bike->GetWorldLocation(), FMath::RadiansToDegrees(FMath::Atan2(V.Y, V.X)), RunTime, NextCheckpoint });
		if (SafePoints.Num() > 64) { SafePoints.RemoveAt(0); }
	}

	Result.TopSpeed = FMath::Max(Result.TopSpeed, Bike->GetSpeed());
	if (!Bike->IsGrounded()) { Result.AirTime += Dt; }
	CleanStreak += Dt;

	// Checkpoints: crossing the next gate's plane within its half-width.
	if (NextCheckpoint < World->Checkpoints.Num())
	{
		const FMcGate& G = World->Checkpoints[NextCheckpoint];
		const bool bGoal = NextCheckpoint == World->Checkpoints.Num() - 1;
		const FVector P = Bike->GetWorldLocation();
		const float D = FVector::Dist2D(P, G.Pos);
		if (bGoal)
		{
			if (D < G.Radius && Bike->GetSpeed() < 3.5f && Bike->IsGrounded())
			{
				Splits.Add(RunTime);
				Deliver();
				return;
			}
			if (D < G.Radius && Bike->GetSpeed() >= 3.5f)
			{
				Prompt = TEXT("BRAKE TO HAND OVER");
			}
			else { Prompt.Reset(); }
		}
		else if (D < G.Radius && FMath::Abs(P.Z - G.Pos.Z) < 800.f)
		{
			Splits.Add(RunTime);
			LastSplitName = G.Name;
			LastSplitAge = 0.f;
			if (BestSplits.IsValidIndex(NextCheckpoint))
			{
				LastSplitDelta = RunTime - BestSplits[NextCheckpoint];
			}
			else { LastSplitDelta = 0.f; }
			++NextCheckpoint;
			if (Audio) { Audio->Ui(TEXT("Checkpoint")); }
		}
	}

	// Route discovery flags (which shortcuts did this run take?).
	if (const TArray<FMcRoutePoint>* Short = World->Routes.Find(TEXT("tags")))
	{
		(void)Short;
	}

	if (Bike->IsCrashed())
	{
		++Result.Crashes;
		EnterPhase(EMcPhase::Respawning);
		// Respawn at a safe point from a couple of seconds before the crash.
		RespawnAt = { World->StartPos, World->StartYaw, 0.f, 0 };
		for (int32 i = SafePoints.Num() - 1; i >= 0; --i)
		{
			if (RunTime - SafePoints[i].Time > 3.2f) { RespawnAt = SafePoints[i]; break; }
		}
		return;
	}
	if (Bike->GetCondition() <= 0.f)
	{
		FailRun(EMcFail::Broken);
		return;
	}
	if (RunTime >= TimeLimit)
	{
		FailRun(EMcFail::Late);
		return;
	}
}

void AMcGameMode::Respawn()
{
	Bike->ResetTo(RespawnAt.Pos, RespawnAt.Yaw, 3.f);
	Bike->SetFrozen(false);
	Bike->SnapCamera();
	// Drop safe points after this one so a second crash doesn't go further back.
	SafePoints.RemoveAll([this](const FSafePoint& S) { return S.Time > RespawnAt.Time; });
	if (Bike->GetCondition() <= 0.f) { FailRun(EMcFail::Broken); }
}

void AMcGameMode::HandleShocks()
{
	for (const FMcShockEvent& E : Bike->PendingShocks)
	{
		if (Audio) { Audio->Shock(E); }
		Rumble(E.Type == EMcShock::Crash || E.Type == EMcShock::Splash ? 1.f : FMath::Clamp(E.Strength * 0.18f + E.Damage * 0.05f, 0.f, 0.9f),
			E.Type == EMcShock::Crash ? 0.5f : 0.12f + FMath::Min(E.Damage, 10.f) * 0.02f);
		if (E.Damage > 0.4f)
		{
			DamageFlash = FMath::Clamp(DamageFlash + E.Damage * 0.08f, 0.f, 1.f);
			LastDamage = E.Damage;
			CleanStreak = 0.f;
		}
		const FString Pct = FString::Printf(TEXT("-%d%%"), FMath::Max(1, FMath::RoundToInt(E.Damage)));
		switch (E.Type)
		{
		case EMcShock::Wall:
			if (E.Damage >= 1.f) { AddCallout(TEXT("WALL"), Pct, ColBad, 0.9f); }
			break;
		case EMcShock::Rattle:
			if (E.Damage >= 2.f && Bike->IsGrounded()) { AddCallout(TEXT("RATTLED"), Pct, ColWarn, 0.8f, 1.1f); }
			break;
		case EMcShock::Crash:
			AddCallout(TEXT("WIPEOUT"), Pct, ColBad, 1.3f, 2.0f);
			break;
		case EMcShock::Splash:
			AddCallout(TEXT("SPLASH"), TEXT("package soaked ") + Pct, ColBad, 1.3f, 2.0f);
			break;
		default: break;
		}
	}
	Bike->PendingShocks.Reset();

	for (const FMcLandingEvent& L : Bike->PendingLandings)
	{
		++Result.Landings;
		if (Audio) { Audio->Landing(L); }
		const FString Dmg = L.Damage >= 0.5f ? FString::Printf(TEXT("-%d%%"), FMath::RoundToInt(L.Damage)) : FString(TEXT("no damage"));
		if (L.bPerfect && L.Damage < 3.f && L.DropHeight > 0.6f)
		{
			++Result.PerfectLandings;
			AddCallout(TEXT("FEATHER LANDING"), FString::Printf(TEXT("%.1fm drop  ·  %s"), L.DropHeight, *Dmg), ColGood, 1.1f);
		}
		else if (L.bSketchy)
		{
			AddCallout(TEXT("SKETCHY"), Dmg, ColBad, 1.f);
		}
		else if (L.Damage >= 6.f)
		{
			AddCallout(TEXT("HARD LANDING"), Dmg, ColBad, 1.f);
		}
		else if (L.Damage >= 1.5f)
		{
			AddCallout(TEXT("THUD"), Dmg, ColWarn, 0.85f);
		}
		else if (L.DropHeight > 1.2f)
		{
			AddCallout(TEXT("CLEAN"), FString::Printf(TEXT("%.1fm drop"), L.DropHeight), ColGood, 0.9f);
		}
	}
	Bike->PendingLandings.Reset();
}

// ======================================================================================================
// End of a run
// ======================================================================================================
void AMcGameMode::ComputeResult()
{
	Result.Time = RunTime;
	Result.Condition = Bike->GetCondition();
	const float TimeLeft = FMath::Max(0.f, TimeLimit - RunTime);
	// The tip: a base fee plus a dollar for every second early, scaled by the state of the package.
	// A pristine box earns a bonus on top, so careful-and-fast beats reckless-and-faster.
	Result.TimeBonus = TimeLeft * 1.0f;
	Result.CareMultiplier = FMath::Pow(Result.Condition / 100.f, 1.5f);
	Result.PristineBonus = Result.Condition >= 95.f ? 15.f : (Result.Condition >= 85.f ? 6.f : 0.f);
	Result.Tip = (20.f + Result.TimeBonus) * Result.CareMultiplier + Result.PristineBonus;
	const float T = Result.Tip;
	Result.Grade = T >= 85.f ? TEXT("S") : T >= 65.f ? TEXT("A") : T >= 48.f ? TEXT("B") : T >= 32.f ? TEXT("C") : TEXT("D");
}

void AMcGameMode::Deliver()
{
	ComputeResult();
	Bike->SetFrozen(false);
	EnterPhase(EMcPhase::Delivered);
	Prompt.Reset();
	World->SetGoalActive(false);
	if (Ghost) { Ghost->SetActorHiddenInGame(true); }
	UE_LOG(LogMc, Display, TEXT("MC_RESULT delivered time=%.2f condition=%.1f tip=%.2f grade=%s landings=%d perfect=%d crashes=%d top=%.1f"),
		Result.Time, Result.Condition, Result.Tip, *Result.Grade, Result.Landings, Result.PerfectLandings, Result.Crashes, Result.TopSpeed);
	// Test runs (autopilot, scripted input, invincible) never become records.
	const bool bTestRun = bAutopilot || Script.Num() > 0 || AMcBike::bInvincible;
	if (!bTestRun && (!bHasBest || Result.Tip > Best.Tip))
	{
		bNewBest = bHasBest || true;
		Best = Result;
		bHasBest = true;
		BestSplits = Splits;
		BestGhost = Recording;
		SaveBest();
	}
}

void AMcGameMode::FailRun(EMcFail Why)
{
	Fail = Why;
	ComputeResult();
	Result.Tip = 0.f;
	Result.Grade = TEXT("-");
	EnterPhase(EMcPhase::Failed);
	Prompt.Reset();
	if (Ghost) { Ghost->SetActorHiddenInGame(true); }
	UE_LOG(LogMc, Display, TEXT("MC_RESULT failed why=%s time=%.2f condition=%.1f"), Why == EMcFail::Broken ? TEXT("broken") : TEXT("late"), RunTime, Bike->GetCondition());
}

// ======================================================================================================
// Ghost + saves
// ======================================================================================================
void AMcGameMode::UpdateGhost(float Dt)
{
	if (!Ghost || Ghost->IsHidden() || BestGhost.Num() < 2) { return; }
	const float T = Phase == EMcPhase::Countdown ? 0.f : RunTime;
	const float F = T * 30.f;
	const int32 I = FMath::Clamp((int32)F, 0, BestGhost.Num() - 2);
	const float A = FMath::Clamp(F - I, 0.f, 1.f);
	const FMcGhostFrame& G0 = BestGhost[I];
	const FMcGhostFrame& G1 = BestGhost[I + 1];
	const FVector P = FMath::Lerp(G0.Pos, G1.Pos, A);
	FRotator R;
	R.Pitch = FMath::Lerp(G0.Rot.Pitch, G1.Rot.Pitch, A);
	R.Yaw = G0.Rot.Yaw + FMath::FindDeltaAngleDegrees(G0.Rot.Yaw, G1.Rot.Yaw) * A;
	R.Roll = FMath::Lerp(G0.Rot.Roll, G1.Rot.Roll, A);
	Ghost->SetPoseFromRecording(P, R, T * 9.f, FMath::Lerp(G0.Wheel, G1.Wheel, A), G0.Crouch);
	if (F >= BestGhost.Num() - 1) { Ghost->SetActorHiddenInGame(true); }
}

void AMcGameMode::SaveBest()
{
	FBufferArchive Ar;
	int32 Version = SaveVersion;
	Ar << Version;
	Ar << Best.Time << Best.Condition << Best.Tip << Best.Grade << Best.Landings << Best.PerfectLandings << Best.Crashes << Best.TopSpeed;
	Ar << BestSplits;
	int32 N = BestGhost.Num();
	Ar << N;
	for (FMcGhostFrame& F : BestGhost) { Ar << F.Pos << F.Rot << F.Crank << F.Wheel << F.Crouch; }
	const FString Path = FPaths::ProjectSavedDir() / TEXT("Courier/best.run");
	FFileHelper::SaveArrayToFile(Ar, *Path);
}

void AMcGameMode::LoadBest()
{
	TArray<uint8> Data;
	const FString Path = FPaths::ProjectSavedDir() / TEXT("Courier/best.run");
	if (!FFileHelper::LoadFileToArray(Data, *Path)) { return; }
	FMemoryReader Ar(Data);
	int32 Version = 0;
	Ar << Version;
	if (Version != SaveVersion) { return; }
	Ar << Best.Time << Best.Condition << Best.Tip << Best.Grade << Best.Landings << Best.PerfectLandings << Best.Crashes << Best.TopSpeed;
	Ar << BestSplits;
	int32 N = 0;
	Ar << N;
	BestGhost.SetNum(FMath::Clamp(N, 0, 30 * 60 * 5));
	for (FMcGhostFrame& F : BestGhost) { Ar << F.Pos << F.Rot << F.Crank << F.Wheel << F.Crouch; }
	bHasBest = !Ar.IsError();
	if (!bHasBest) { BestGhost.Reset(); BestSplits.Reset(); }
}

// ======================================================================================================
// Title camera, dev hooks
// ======================================================================================================
void AMcGameMode::UpdateTitleCamera(float Dt)
{
	TitleOrbit += Dt * 4.f;
	const FVector C = Bike->GetWorldLocation() + FVector(0, 0, 120.f);
	const float Yaw = World->StartYaw + 150.f + FMath::Sin(FMath::DegreesToRadians(TitleOrbit)) * 25.f;
	const FRotator R(-6.f, Yaw, 0.f);
	const FVector Loc = C - R.Vector() * 520.f + FVector(0, 0, 40.f);
	Bike->bCameraOverride = true;
	Bike->OverrideLoc = Loc;
	Bike->OverrideRot = (C + FVector(0, 0, 10.f) - Loc).Rotation();
	Bike->OverrideFov = 55.f;
}

void AMcGameMode::TickDev(float Dt)
{
	if (!FilmName.IsEmpty() && DevClock >= FilmStart)
	{
		const FString Path = FPaths::ConvertRelativePathToFull(FPaths::ProjectSavedDir() / TEXT("Shots") / FilmName / FString::Printf(TEXT("%05d.png"), FilmFrame++));
		FScreenshotRequest::RequestScreenshot(Path, true, false);
	}
	// Frame-rate report every five seconds.
	PerfTime += Dt;
	PerfFrames += 1;
	PerfWorst = FMath::Max(PerfWorst, Dt);
	if (PerfTime >= 5.f)
	{
		UE_LOG(LogMc, Display, TEXT("MC_PERF fps=%.1f worst=%.1fms"), PerfFrames / PerfTime, PerfWorst * 1000.f);
		PerfTime = 0.f; PerfFrames = 0; PerfWorst = 0.f;
	}
	for (FShot& S : Shots)
	{
		if (!S.bTaken && DevClock >= S.Time)
		{
			S.bTaken = true;
			const FString Path = FPaths::ConvertRelativePathToFull(FPaths::ProjectSavedDir() / TEXT("Shots") / (S.Name + TEXT(".png")));
			FScreenshotRequest::RequestScreenshot(Path, true, false);
			UE_LOG(LogMc, Display, TEXT("MC_SHOT %s at %.2f"), *Path, DevClock);
		}
	}
	if (bTelemetry && Phase == EMcPhase::Riding)
	{
		TelemetryAccum += Dt;
		if (TelemetryAccum > 0.25f)
		{
			TelemetryAccum = 0.f;
			const FVector P = Bike->GetWorldLocation();
			UE_LOG(LogMc, Display, TEXT("MC_TEL t=%.2f pos=%.0f,%.0f,%.0f speed=%.2f fwd=%.2f yaw=%.1f pitch=%.1f lean=%.1f ground=%d air=%.2f cond=%.1f g=%.2f cp=%d"),
				RunTime, P.X, P.Y, P.Z, Bike->GetSpeed(), Bike->GetForwardSpeed(), Bike->GetYawDeg(), Bike->GetPitchDeg(), Bike->GetLeanDeg(),
				Bike->IsGrounded() ? 1 : 0, Bike->GetAirTime(), Bike->GetCondition(), Bike->GetPackageG(), NextCheckpoint);
		}
	}
	if (QuitAt > 0.f && DevClock >= QuitAt)
	{
		QuitAt = -1.f;
		UE_LOG(LogMc, Display, TEXT("MC_QUIT phase=%d time=%.2f condition=%.1f"), (int32)Phase, RunTime, Bike->GetCondition());
		if (APlayerController* PC = GetWorld()->GetFirstPlayerController()) { PC->ConsoleCommand(TEXT("quit")); }
	}
}
