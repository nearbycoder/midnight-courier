#pragma once

#include "CoreMinimal.h"
#include "UObject/Object.h"
#include "McTypes.h"
#include "McAudio.generated.h"

class UAudioComponent;
class AMcBike;
class AMcGameMode;
enum class EMcPhase : uint8;

/** All the game's sound: rain bed, speed-driven bike loops, impacts, the package's glassy complaints, music. */
UCLASS()
class UMcAudio : public UObject
{
	GENERATED_BODY()

public:
	void Init(UWorld* InWorld, AMcBike* InBike);
	void Update(float Dt, AMcGameMode* Game);
	void OnPhase(EMcPhase Phase);
	void OnRestart();
	void Ui(const TCHAR* Name);
	void Shock(const FMcShockEvent& E);
	void Landing(const FMcLandingEvent& L);
	void Play(const TCHAR* Name, float Volume = 1.f, float Pitch = 1.f);

protected:
	UAudioComponent* Loop(const TCHAR* Name, float Volume);

	TWeakObjectPtr<UWorld> World;
	TWeakObjectPtr<AMcBike> Bike;
	UPROPERTY() TObjectPtr<UAudioComponent> Rain;
	UPROPERTY() TObjectPtr<UAudioComponent> City;
	UPROPERTY() TObjectPtr<UAudioComponent> Wind;
	UPROPERTY() TObjectPtr<UAudioComponent> Roll;
	UPROPERTY() TObjectPtr<UAudioComponent> Freewheel;
	UPROPERTY() TObjectPtr<UAudioComponent> Chain;
	UPROPERTY() TObjectPtr<UAudioComponent> Skid;
	UPROPERTY() TObjectPtr<UAudioComponent> Music;
	UPROPERTY() TObjectPtr<UAudioComponent> TitleMusic;
	float MusicLevel = 0.f;
	float TitleLevel = 1.f;
	float WasAirborne = 0.f;
	float LastTink = 0.f;
	float Clock = 0.f;
	int32 LastCountdown = -1;
	bool bMuted = false;
};
