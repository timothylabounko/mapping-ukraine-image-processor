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
    user = models.ForeignKey(User, on_delete=models.CASCADE)
    title = models.CharField(max_length=255)
    description = models.TextField()
    latitude = models.FloatField()
    longitude = models.FloatField()
    address = models.CharField(max_length=255)
    azimuth = models.FloatField()
    upload_date = models.DateTimeField(auto_now_add=True)
    picture_date = models.DateTimeField()
    metadata = models.JSONField()

    def __str__(self):
        return self.title