from django.db import models

# USERS TABLE
class User(models.Model):
    user_id = models.AutoField(primary_key=True)
    password = models.CharField(max_length=255)
    phone_number = models.CharField(max_length=20)
    email = models.EmailField(unique=True)

    def __str__(self):
        return self.email


# IMAGES TABLE
class Image(models.Model):
    image_id = models.AutoField(primary_key=True)
    user = models.ForeignKey('User', on_delete=models.CASCADE)
    title = models.CharField(max_length=255)
    description = models.TextField()
    latitude = models.FloatField(null=True, blank=True)
    longitude = models.FloatField(null=True, blank=True)
    address = models.CharField(max_length=255, blank=True)
    azimuth = models.FloatField(null=True, blank=True)
    upload_date = models.DateTimeField(auto_now_add=True)
    picture_date = models.DateTimeField(null=True, blank=True)
    metadata = models.JSONField(blank=True, null=True)
    file = models.ImageField(upload_to='uploads/', null=True, blank=True)  # ✅ added

    def __str__(self):
        return self.title