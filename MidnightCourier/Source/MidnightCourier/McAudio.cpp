#include "McAudio.h"

#include "Components/AudioComponent.h"
#include "Kismet/GameplayStatics.h"
#include "McAssets.h"
#include "McBike.h"
#include "McGame.h"
#include "McWorld.h"
#include "McSettings.h"
#include "Sound/SoundBase.h"

void UMcAudio::Init(UWorld* InWorld, AMcBike* InBike)
{
	World = InWorld;
	Bike = InBike;
	bMuted = FParse::Param(FCommandLine::Get(), TEXT("McMute"));
	Rain = Loop(TEXT("A_RainLoop"), 0.7f);
	City = Loop(TEXT("A_CityLoop"), 0.35f);
	Wind = Loop(TEXT("A_WindLoop"), 0.f);
	Roll = Loop(TEXT("A_RollLoop"), 0.f);
	Freewheel = Loop(TEXT("A_FreewheelLoop"), 0.f);
	Chain = Loop(TEXT("A_ChainLoop"), 0.f);
	Skid = Loop(TEXT("A_SkidLoop"), 0.f);
	Music = Loop(TEXT("A_MusicRide"), 0.f);
	TitleMusic = Loop(TEXT("A_MusicTitle"), 0.6f);
}

UAudioComponent* UMcAudio::Loop(const TCHAR* Name, float Volume)
{
	USoundBase* S = McAssets::Sound(Name);
	if (!S || !World.IsValid() || bMuted) { return nullptr; }
	UAudioComponent* C = UGameplayStatics::CreateSound2D(World.Get(), S, 1.f, 1.f, 0.f, nullptr, true, false);
	if (!C) { return nullptr; }
	C->bIsUISound = false;
	C->SetVolumeMultiplier(FMath::Max(Volume, 0.001f));
	C->Play();
	return C;
}

void UMcAudio::Play(const TCHAR* Name, float Volume, float Pitch)
{
	if (bMuted || !World.IsValid()) { return; }
	if (USoundBase* S = McAssets::Sound(Name))
	{
		UGameplayStatics::PlaySound2D(World.Get(), S, Volume * FMcSettings::Get().Volume(FMcSettings::Get().Effects), Pitch);
	}
}

void UMcAudio::Ui(const TCHAR* Name)
{
	Play(*FString::Printf(TEXT("A_Ui%s"), Name), 0.8f);
}

void UMcAudio::OnPhase(EMcPhase Phase)
{
	switch (Phase)
	{
	case EMcPhase::Delivered: Play(TEXT("A_Delivered"), 0.9f); break;
	case EMcPhase::Failed: Play(TEXT("A_Failed"), 0.9f); break;
	default: break;
	}
}

void UMcAudio::OnRestart()
{
	LastCountdown = -1;
	Play(TEXT("A_Restart"), 0.7f);
}

void UMcAudio::Shock(const FMcShockEvent& E)
{
	const float Pitch = FMath::FRandRange(0.9f, 1.1f);
	switch (E.Type)
	{
	case EMcShock::Rattle:
		Play(TEXT("A_Clack"), FMath::Clamp(E.Strength * 0.35f, 0.1f, 0.9f), Pitch);
		break;
	case EMcShock::Landing:
		Play(E.Strength > 3.f ? TEXT("A_ThudHeavy") : TEXT("A_ThudLight"), FMath::Clamp(E.Strength * 0.25f, 0.2f, 1.f), Pitch);
		break;
	case EMcShock::Wall:
		Play(TEXT("A_WallHit"), FMath::Clamp(E.Strength * 0.2f, 0.15f, 1.f), Pitch);
		break;
	case EMcShock::Crash:
		Play(TEXT("A_Crash"), 1.f);
		break;
	case EMcShock::Splash:
		Play(TEXT("A_Splash"), 1.f);
		break;
	}
	// The package complains: glassy tinkles for small knocks, a crack for real damage.
	if (E.Damage >= 4.f)
	{
		Play(TEXT("A_GlassCrack"), FMath::Clamp(0.4f + E.Damage * 0.04f, 0.4f, 1.f), FMath::FRandRange(0.92f, 1.08f));
	}
	else if (E.Strength > 0.6f && Clock - LastTink > 0.07f)
	{
		LastTink = Clock;
		Play(TEXT("A_GlassTink"), FMath::Clamp(E.Strength * 0.3f, 0.12f, 0.8f), FMath::FRandRange(0.85f, 1.25f));
	}
}

void UMcAudio::Landing(const FMcLandingEvent& L)
{
	if (L.bPerfect && L.Damage < 3.f && L.DropHeight > 0.6f) { Play(TEXT("A_Perfect"), 0.6f); }
}

void UMcAudio::Update(float Dt, AMcGameMode* Game)
{
	Clock += Dt;
	AMcBike* B = Bike.Get();
	if (!B || !Game) { return; }
	const bool bRiding = Game->Phase == EMcPhase::Riding || Game->Phase == EMcPhase::Respawning;
	const bool bOnBike = bRiding || Game->Phase == EMcPhase::Delivered || Game->Phase == EMcPhase::Failed;
	const float Speed = B->GetSpeed();
	const bool bGround = B->IsGrounded() && !B->IsCrashed();
	const float S01 = FMath::Clamp(Speed / 16.f, 0.f, 1.f);
	const FMcSettings& Set = FMcSettings::Get();
	const float FxV = Set.Volume(Set.Effects), MusV = Set.Volume(Set.Music), AmbV = Set.Volume(Set.Ambience);

	if (Wind) { Wind->SetVolumeMultiplier(FMath::Max(0.001f, FxV * (bOnBike ? S01 * S01 * 0.9f : 0.f))); Wind->SetPitchMultiplier(0.7f + S01 * 0.7f); }
	if (Roll) { Roll->SetVolumeMultiplier(FMath::Max(0.001f, FxV * (bOnBike && bGround ? FMath::Clamp(Speed / 10.f, 0.f, 1.f) * 0.7f : 0.f))); Roll->SetPitchMultiplier(0.6f + S01 * 0.8f); }
	const bool bPedal = bRiding && B->Input.Throttle > 0.05f && !B->IsBraced() && bGround;
	if (Chain) { Chain->SetVolumeMultiplier(FMath::Max(0.001f, FxV * (bPedal ? 0.35f : 0.f))); Chain->SetPitchMultiplier(0.8f + S01 * 0.6f); }
	if (Freewheel) { Freewheel->SetVolumeMultiplier(FMath::Max(0.001f, FxV * (bOnBike && !bPedal && Speed > 1.f ? 0.25f : 0.f))); Freewheel->SetPitchMultiplier(0.4f + FMath::Clamp(Speed / 12.f, 0.f, 1.6f)); }
	const float SkidLevel = bOnBike && bGround ? FMath::Clamp(B->GetSlip() * 1.2f + (B->Input.Brake > 0.5f && Speed > 5.f ? 0.25f : 0.f), 0.f, 1.f) : 0.f;
	if (Skid) { Skid->SetVolumeMultiplier(FMath::Max(0.001f, FxV * SkidLevel * 0.6f)); Skid->SetPitchMultiplier(0.85f + S01 * 0.3f); }

	// Music: the ride track comes in once you're moving, the title track on menus.
	const float WantMusic = bRiding || Game->Phase == EMcPhase::Countdown ? 0.55f : 0.f;
	const float WantTitle = Game->Phase == EMcPhase::Title ? 0.6f : (Game->Phase == EMcPhase::Delivered || Game->Phase == EMcPhase::Failed ? 0.35f : 0.f);
	MusicLevel = FMath::FInterpTo(MusicLevel, WantMusic, Dt, 1.5f);
	TitleLevel = FMath::FInterpTo(TitleLevel, WantTitle, Dt, 1.0f);
	if (Music) { Music->SetVolumeMultiplier(FMath::Max(0.001f, MusicLevel * MusV)); }
	if (TitleMusic) { TitleMusic->SetVolumeMultiplier(FMath::Max(0.001f, TitleLevel * MusV)); }
	if (Rain) { Rain->SetVolumeMultiplier(FMath::Max(0.001f, AmbV * (0.55f + 0.2f * (1.f - S01)))); }
	if (City) { City->SetVolumeMultiplier(FMath::Max(0.001f, AmbV * 0.35f)); }

	// Countdown beeps.
	if (Game->Phase == EMcPhase::Countdown)
	{
		const int32 Step = FMath::FloorToInt(Game->PhaseTime / 0.5f);
		if (Step != LastCountdown && Step < 3)
		{
			LastCountdown = Step;
			Play(TEXT("A_Beep"), 0.6f, 1.f);
		}
	}
	else if (Game->Phase == EMcPhase::Riding && LastCountdown >= 0 && LastCountdown < 3)
	{
		LastCountdown = 99;
		Play(TEXT("A_Go"), 0.7f);
	}

	if (B->bJustHopped) { Play(TEXT("A_Hop"), 0.5f, FMath::FRandRange(0.95f, 1.05f)); }

	if (AMcWorld* W = Game->GetCourierWorld())
	{
		if (W->bThunderPending)
		{
			W->ThunderDelay -= Dt;
			if (W->ThunderDelay <= 0.f)
			{
				W->bThunderPending = false;
				Play(FMath::RandBool() ? TEXT("A_Thunder1") : TEXT("A_Thunder2"), 0.8f);
			}
		}
	}
}
