#pragma once

#include "CoreMinimal.h"
#include "GameFramework/HUD.h"
#include "McHud.generated.h"

class AMcGameMode;
class UFont;

enum class EMcFace : uint8 { Display, Bold, Semi, Medium, Italic, HeavyItalic };
enum class EMcAlign : uint8 { Left, Center, Right };

UCLASS()
class AMcHud : public AHUD
{
	GENERATED_BODY()

public:
	virtual void DrawHUD() override;

protected:
	void DrawRiding(AMcGameMode* G);
	void DrawTitle(AMcGameMode* G);
	void DrawResults(AMcGameMode* G);
	void DrawPause(AMcGameMode* G);
	void DrawSettings(AMcGameMode* G);
	void DrawMinimap(AMcGameMode* G, float X, float Y, float Size);
	void DrawPackage(AMcGameMode* G, float X, float Y);

	float Text(const FString& S, float X, float Y, EMcFace Face, float Size, const FLinearColor& C, EMcAlign Align = EMcAlign::Left, float Shadow = 2.f, float Spacing = 0.f);
	FVector2D Measure(const FString& S, EMcFace Face, float Size, float Spacing = 0.f);
	void Rect(float X, float Y, float W, float H, const FLinearColor& C);
	void Line(float X0, float Y0, float X1, float Y1, const FLinearColor& C, float Thick = 1.f);
	FString FormatTime(float T, bool bTenths = true) const;

	float S = 1.f;     // UI scale (1 at 1080 lines)
	float W = 0.f, H = 0.f;
	float Clock = 0.f;
	float ShownCondition = 100.f;
	float ShownG = 1.f;
	float TipCounter = 0.f;
};
